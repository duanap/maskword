import { computed, ref } from "vue";
import {
  AVATAR_IDS,
  createRoleDeck,
  createSpeakingOrder,
  determineWinner,
  filterWordPairs,
  isExplosiveMode,
  isHiddenMode,
  normalizeGuess,
  normalizedNicknameKey,
  normalizeNickname,
  roleConfigError,
  settleVotes,
  type AvatarId,
  type Role,
  type RoundResult,
  type SelfDestructResult,
  type WordPair,
} from "@maskword/shared";
import { clearOfflineState, loadOfflineState, saveOfflineState } from "./offline-storage";
import type { OfflineGameState, OfflineMember, OfflineSetup } from "./types";

export function validateOfflineSetup(setup: OfflineSetup): string | null {
  if (!Number.isInteger(setup.participantCount) || setup.participantCount < 3 || setup.participantCount > 12) return "参赛人数需要为 3–12 人";
  const expectedNames = setup.participantCount + (setup.hostParticipates ? 0 : 1);
  if (setup.names.length !== expectedNames) return "玩家人数与姓名数量不一致";
  const cleanNames = setup.names.map(normalizeNickname);
  if (cleanNames.some((name) => !name || [...name].length > 12)) return "姓名长度需要为 1–12 个字符";
  if (new Set(cleanNames.map(normalizedNicknameKey)).size !== cleanNames.length) return "玩家姓名不能重复";
  if (setup.config.hostParticipates !== setup.hostParticipates) return "主持人参赛设置不一致";
  const configError = roleConfigError(setup.config);
  if (configError) return configError;
  if (!filterWordPairs(setup.config.wordCategory, setup.config.wordDifficulty).length) return "当前词库筛选结果为空";
  if (setup.customWords) {
    if (setup.hostParticipates) return "只有不参赛的主持人可自定义词语";
    const words = [setup.customWords.civilian.trim(), setup.customWords.undercover.trim()];
    if (words.some((word) => [...word].length < 1 || [...word].length > 12)) return "自定义词语长度需要为 1–12 个字符";
    if (normalizeGuess(words[0] ?? "") === normalizeGuess(words[1] ?? "")) return "平民词和卧底词不能相同";
  }
  return null;
}

function createMembers(setup: OfflineSetup): OfflineMember[] {
  return setup.names.map((nickname, index) => ({
    id: `local-${index + 1}`,
    nickname: normalizeNickname(nickname),
    avatarId: setup.avatars?.[index] ?? AVATAR_IDS[index] ?? "robot",
    participates: setup.hostParticipates || index > 0,
    alive: setup.hostParticipates || index > 0,
    left: false,
    role: null,
    word: null,
    roleRevealed: false,
    selfDestructUsed: false,
  }));
}

export function createOfflineGame(random: () => number = Math.random) {
  const loaded = loadOfflineState();
  const resumeCandidate = ref(loaded.state);
  const storageWarning = ref(loaded.legacyCleared
    ? "旧版进行中对局与 V2 规则不兼容，已清除，请重新开局"
    : loaded.corrupted ? "上次存档无法恢复，已安全清除" : null);
  const state = ref<OfflineGameState | null>(null);
  const membersById = computed(() => new Map(state.value?.members.map((member) => [member.id, member]) ?? []));
  const aliveMembers = computed(() => state.value?.members.filter((member) => member.participates && member.alive && !member.left) ?? []);
  const currentPrivatePlayer = computed(() => membersById.value.get(state.value?.privacy.playerId ?? "") ?? null);
  const currentSpeaker = computed(() => membersById.value.get(state.value?.speakingOrder[state.value?.speakerIndex ?? -1] ?? "") ?? null);
  const currentVoter = computed(() => membersById.value.get(state.value?.voterOrder[state.value?.voterIndex ?? -1] ?? "") ?? null);

  function commit() {
    if (!state.value) return;
    state.value.updatedAt = Date.now();
    saveOfflineState(state.value);
  }

  function pickWordPair(setup: OfflineSetup): WordPair {
    if (setup.customWords) return {
      civilian: setup.customWords.civilian.trim(), undercover: setup.customWords.undercover.trim(),
      category: setup.config.wordCategory, difficulty: setup.config.wordDifficulty, audience: "GENERAL",
    };
    const pool = filterWordPairs(setup.config.wordCategory, setup.config.wordDifficulty);
    const pair = pool[Math.floor(random() * pool.length)];
    if (!pair) throw new Error("词库为空");
    return { ...pair };
  }

  function deal(current: OfflineGameState) {
    const participants = current.members.filter((member) => member.participates && !member.left);
    const roles = createRoleDeck(current.config, random);
    participants.forEach((member, index) => {
      const role = roles[index];
      if (!role) throw new Error("身份分配失败");
      member.role = role;
      member.alive = true;
      member.word = role === "CIVILIAN" ? current.wordPair.civilian : role === "BLANK" ? null : current.wordPair.undercover;
      member.roleRevealed = !isHiddenMode(current.config.mode);
      member.selfDestructUsed = false;
    });
    current.phase = "DEALING";
    current.dealingIndex = 0;
    current.round = 1;
    current.speakingOrder = [];
    current.speakerIndex = 0;
    current.speakingStartedAt = null;
    current.speakingDeadlineAt = null;
    current.voterOrder = [];
    current.voterIndex = 0;
    current.votes = {};
    current.sealedGuesses = {};
    current.candidateIds = [];
    current.runoffTallies = null;
    current.roundResult = null;
    current.rounds = [];
    current.winner = null;
    current.notice = null;
    current.privacy = { mode: "HANDOFF", playerId: participants[0]?.id ?? null, purpose: "DEALING" };
  }

  function start(setup: OfflineSetup): string | null {
    const error = validateOfflineSetup(setup);
    if (error) return error;
    const now = Date.now();
    const current: OfflineGameState = {
      schemaVersion: 2, phase: "DEALING", config: { ...setup.config }, participantCount: setup.participantCount,
      hostId: "local-1", members: createMembers(setup), wordPair: pickWordPair(setup), round: 1, dealingIndex: 0,
      speakingOrder: [], speakerIndex: 0, speakingStartedAt: null, speakingDeadlineAt: null,
      voterOrder: [], voterIndex: 0, votes: {}, sealedGuesses: {}, candidateIds: [], runoffTallies: null,
      privacy: { mode: "PUBLIC", playerId: null, purpose: null }, roundResult: null, rounds: [], winner: null,
      notice: null, startedAt: now, updatedAt: now,
    };
    deal(current);
    state.value = current;
    resumeCandidate.value = null;
    commit();
    return null;
  }

  function resume() { if (resumeCandidate.value) { state.value = resumeCandidate.value; resumeCandidate.value = null; commit(); } }
  function abandon() { state.value = null; resumeCandidate.value = null; clearOfflineState(); }
  function beginPrivateTurn() {
    const current = state.value;
    if (!current || current.privacy.mode !== "HANDOFF") return;
    current.privacy.mode = current.privacy.purpose === "DEALING" || current.privacy.purpose === "RECHECK" ? "REVEAL" : "CAST";
    commit();
  }

  function enterSpeaking(current: OfflineGameState) {
    const holders = current.members
      .filter((member): member is OfflineMember & { role: Role } => member.participates && member.alive && !member.left && member.role !== null)
      .map((member) => ({ id: member.id, role: member.role }));
    current.phase = "SPEAKING";
    current.speakingOrder = createSpeakingOrder(holders, random);
    current.speakerIndex = 0;
    current.speakingStartedAt = null;
    current.speakingDeadlineAt = null;
    current.privacy = { mode: "PUBLIC", playerId: null, purpose: null };
  }

  function hideIdentity() {
    const current = state.value;
    if (!current || current.privacy.mode !== "REVEAL") return;
    if (current.privacy.purpose === "DEALING") {
      const participants = current.members.filter((member) => member.participates && !member.left);
      current.dealingIndex += 1;
      const next = participants[current.dealingIndex];
      if (next) current.privacy = { mode: "HANDOFF", playerId: next.id, purpose: "DEALING" };
      else enterSpeaking(current);
    } else current.privacy = { mode: "PUBLIC", playerId: null, purpose: null };
    commit();
  }

  function forceHideSecret() {
    const current = state.value;
    if (current && (current.privacy.mode === "REVEAL" || current.privacy.mode === "CAST")) {
      current.privacy.mode = "HANDOFF";
      commit();
    }
  }

  function startSpeaking() {
    const current = state.value;
    if (!current || current.phase !== "SPEAKING" || current.speakingStartedAt !== null) return;
    current.speakingStartedAt = Date.now();
    current.speakingDeadlineAt = current.config.speakingSeconds ? Date.now() + current.config.speakingSeconds * 1_000 : null;
    commit();
  }

  function nextSpeaker() {
    const current = state.value;
    if (!current || current.phase !== "SPEAKING") return;
    current.speakingStartedAt = null;
    current.speakingDeadlineAt = null;
    if (current.speakerIndex < current.speakingOrder.length - 1) current.speakerIndex += 1;
    else beginVoting("VOTING");
    commit();
  }

  function recheckIdentity(playerId: string) {
    const current = state.value;
    const member = membersById.value.get(playerId);
    if (!current || current.phase !== "SPEAKING" || !member?.alive || member.left || !member.participates) return;
    current.privacy = { mode: "HANDOFF", playerId, purpose: "RECHECK" };
    commit();
  }

  function ordinaryUndercoverAlive(current: OfflineGameState) {
    return current.members.some((member) => member.participates && member.alive && !member.left && member.role === "UNDERCOVER");
  }

  function canGuess(member: OfflineMember | null): boolean {
    const current = state.value;
    if (!current || !member || current.phase !== "VOTING" || !isExplosiveMode(current.config.mode)) return false;
    if (!member.alive || member.selfDestructUsed || current.round < current.config.selfDestructRound) return false;
    return member.role === "UNDERCOVER" || (member.role === "DOUBLE_AGENT" && !ordinaryUndercoverAlive(current));
  }

  function revealEligible(current: OfflineGameState) {
    if (!isHiddenMode(current.config.mode) || !isExplosiveMode(current.config.mode)) return;
    if (current.round >= current.config.selfDestructRound) {
      current.members.forEach((member) => { if (member.alive && member.role === "UNDERCOVER") member.roleRevealed = true; });
    }
    if (!ordinaryUndercoverAlive(current)) current.members.forEach((member) => { if (member.alive && member.role === "DOUBLE_AGENT") member.roleRevealed = true; });
  }

  function beginVoting(kind: "VOTING" | "RUNOFF") {
    const current = state.value;
    if (!current) return;
    const voters = current.members.filter((member) => member.participates && member.alive && !member.left);
    current.phase = kind;
    current.voterOrder = voters.map((member) => member.id);
    current.voterIndex = 0;
    current.votes = {};
    if (kind === "VOTING") {
      current.candidateIds = current.voterOrder.slice();
      current.runoffTallies = null;
      current.sealedGuesses = {};
      revealEligible(current);
    }
    current.privacy = { mode: "HANDOFF", playerId: current.voterOrder[0] ?? null, purpose: kind };
    commit();
  }

  function submitVote(targetId: string | null, rawGuess?: string): string | null {
    const current = state.value;
    const voter = currentVoter.value;
    if (!current || !voter || current.privacy.mode !== "CAST") return "当前不能投票";
    if (targetId === null && aliveMembers.value.length < 4) return "仅剩三人时不能弃权";
    if (targetId !== null && (targetId === voter.id || !current.candidateIds.includes(targetId))) return "请选择有效的其他存活玩家";
    const guess = rawGuess?.trim();
    if (current.phase === "RUNOFF" && guess) return "平票重投不能新增或修改自爆猜词";
    if (guess) {
      if (!canGuess(voter)) return "当前不具备自爆猜词资格";
      if ([...guess].length > 12) return "猜测词语最多 12 个字符";
    }
    current.votes[voter.id] = targetId;
    if (guess) { current.sealedGuesses[voter.id] = guess; voter.selfDestructUsed = true; }
    current.voterIndex += 1;
    const next = current.voterOrder[current.voterIndex];
    if (next) {
      current.privacy = { mode: "HANDOFF", playerId: next, purpose: current.phase === "RUNOFF" ? "RUNOFF" : "VOTING" };
      commit();
    } else settleCurrentVote();
    return null;
  }

  function finishRunoff() { if (state.value?.phase === "RUNOFF") settleCurrentVote(); }

  function settleCurrentVote() {
    const current = state.value;
    if (!current || (current.phase !== "VOTING" && current.phase !== "RUNOFF")) return;
    const kind = current.phase;
    const eligibleIds = current.members.filter((member) => member.participates && member.alive && !member.left).map((member) => member.id);
    const settlement = settleVotes(current.candidateIds, eligibleIds, current.votes);
    if (kind === "VOTING" && settlement.leaderIds.length > 1) {
      current.candidateIds = settlement.leaderIds;
      current.runoffTallies = settlement.tallies.filter((item) => settlement.leaderIds.includes(item.playerId));
      beginVoting("RUNOFF");
      return;
    }
    const guessResults: SelfDestructResult[] = Object.entries(current.sealedGuesses).flatMap(([playerId, guess]) => {
      const member = membersById.value.get(playerId);
      if (!member || (member.role !== "UNDERCOVER" && member.role !== "DOUBLE_AGENT")) return [];
      return [{ playerId, role: member.role, guess, correct: normalizeGuess(guess) === normalizeGuess(current.wordPair.civilian) }];
    });
    const anyCorrect = guessResults.some((item) => item.correct);
    const eliminatedIds = new Set<string>();
    const voteEliminatedPlayerId = !anyCorrect && settlement.leaderIds.length === 1 ? settlement.leaderIds[0] ?? null : null;
    if (!anyCorrect) {
      guessResults.forEach((item) => { if (!item.correct) eliminatedIds.add(item.playerId); });
      if (voteEliminatedPlayerId) eliminatedIds.add(voteEliminatedPlayerId);
      eliminatedIds.forEach((id) => { const member = membersById.value.get(id); if (member) member.alive = false; });
    }
    const fallback: RoundResult["reason"] = settlement.leaderIds.length > 1 ? "TIE" : settlement.leaderIds.length ? "ELIMINATED" : "NO_VALID_VOTE";
    const result: RoundResult = {
      round: current.round, eliminatedPlayerIds: [...eliminatedIds], voteEliminatedPlayerId,
      selfDestructResults: guessResults, tallies: settlement.tallies, abstainCount: settlement.abstainCount,
      reason: eliminatedIds.size > 1 ? "MULTIPLE_ELIMINATED" : eliminatedIds.size ? "ELIMINATED" : fallback,
    };
    current.roundResult = result;
    current.rounds.push(result);
    current.votes = {};
    current.sealedGuesses = {};
    current.voterOrder = [];
    current.voterIndex = 0;
    current.privacy = { mode: "PUBLIC", playerId: null, purpose: null };
    if (anyCorrect) { current.winner = "UNDERCOVER"; current.phase = "ENDED"; }
    else {
      revealEligible(current);
      const winner = winnerForCurrent(current);
      if (winner) { current.winner = winner; current.phase = "ENDED"; }
      else current.phase = "ROUND_RESULT";
    }
    commit();
  }

  function winnerForCurrent(current: OfflineGameState) {
    return determineWinner(current.members
      .filter((member): member is OfflineMember & { role: Role } => member.participates && member.role !== null)
      .map((member) => ({ id: member.id, role: member.role, alive: member.alive, left: member.left })));
  }

  function nextRound() {
    const current = state.value;
    if (!current || current.phase !== "ROUND_RESULT") return;
    current.round += 1;
    current.roundResult = null;
    current.notice = null;
    enterSpeaking(current);
    commit();
  }

  function transferHost(targetId: string): string | null {
    const current = state.value;
    const target = membersById.value.get(targetId);
    if (!current || !target || target.left || target.id === current.hostId) return "请选择其他现场成员";
    current.hostId = targetId;
    commit();
    return null;
  }

  function markLeft(playerId: string): string | null {
    const current = state.value;
    const member = membersById.value.get(playerId);
    if (!current || !member || member.left) return "玩家状态无效";
    if (current.hostId === playerId) return "主持人退出前需要先转移主持权限";
    member.left = true; member.alive = false; delete current.sealedGuesses[playerId];
    const winner = winnerForCurrent(current);
    if (winner) { current.winner = winner; current.phase = "ENDED"; current.privacy = { mode: "PUBLIC", playerId: null, purpose: null }; }
    else if (current.phase === "VOTING") { current.notice = `${member.nickname} 已退出，本轮投票已作废，请重新投票`; beginVoting("VOTING"); }
    else if (current.phase === "RUNOFF" && current.candidateIds.includes(playerId)) settleCurrentVote();
    else commit();
    return null;
  }

  function rematch() {
    const current = state.value;
    if (!current || current.phase !== "ENDED") return;
    current.members.forEach((member) => { member.left = false; member.alive = member.participates; member.role = null; member.word = null; member.selfDestructUsed = false; member.roleRevealed = false; });
    const pool = filterWordPairs(current.config.wordCategory, current.config.wordDifficulty);
    current.wordPair = { ...(pool[Math.floor(random() * pool.length)] as WordPair) };
    current.startedAt = Date.now();
    deal(current);
    commit();
  }

  return {
    state, resumeCandidate, storageWarning, aliveMembers, membersById, currentPrivatePlayer, currentSpeaker, currentVoter,
    start, resume, abandon, beginPrivateTurn, hideIdentity, forceHideSecret, startSpeaking, nextSpeaker, recheckIdentity,
    canGuess, submitVote, finishRunoff, nextRound, transferHost, markLeft, rematch,
  };
}
