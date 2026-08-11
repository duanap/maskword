import { computed, ref } from "vue";
import {
  WORD_PAIRS,
  createRoleDeck,
  createSpeakingOrder,
  determineWinner,
  normalizedNicknameKey,
  normalizeNickname,
  roleConfigError,
  settleVotes,
  type Role,
  type RoundResult,
} from "@maskword/shared";
import { clearOfflineState, loadOfflineState, saveOfflineState } from "./offline-storage";
import type { OfflineGameState, OfflineMember, OfflineSetup } from "./types";

export function validateOfflineSetup(setup: OfflineSetup): string | null {
  if (!Number.isInteger(setup.participantCount) || setup.participantCount < 3 || setup.participantCount > 12) {
    return "参赛人数需要为 3–12 人";
  }
  const expectedNames = setup.participantCount + (setup.hostParticipates ? 0 : 1);
  if (setup.names.length !== expectedNames) return "玩家人数与姓名数量不一致";
  const cleanNames = setup.names.map(normalizeNickname);
  if (cleanNames.some((name) => !name || [...name].length > 12)) return "姓名长度需要为 1–12 个字符";
  if (new Set(cleanNames.map(normalizedNicknameKey)).size !== cleanNames.length) return "玩家姓名不能重复";
  if (setup.config.hostParticipates !== setup.hostParticipates) return "主持人参赛设置不一致";
  return roleConfigError(setup.config);
}

function createMembers(setup: OfflineSetup): OfflineMember[] {
  return setup.names.map((nickname, index) => ({
    id: `local-${index + 1}`,
    nickname: normalizeNickname(nickname),
    participates: setup.hostParticipates || index > 0,
    alive: setup.hostParticipates || index > 0,
    left: false,
    role: null,
    word: null,
  }));
}

export function createOfflineGame(random: () => number = Math.random) {
  const loaded = loadOfflineState();
  const resumeCandidate = ref(loaded.state);
  const storageWarning = ref(loaded.corrupted ? "上次存档无法恢复，已安全清除" : null);
  const state = ref<OfflineGameState | null>(null);

  const membersById = computed(() => new Map(state.value?.members.map((member) => [member.id, member]) ?? []));
  const aliveMembers = computed(() => state.value?.members.filter((member) => member.participates && member.alive && !member.left) ?? []);
  const currentPrivatePlayer = computed(() => {
    const playerId = state.value?.privacy.playerId;
    return playerId ? membersById.value.get(playerId) ?? null : null;
  });
  const currentSpeaker = computed(() => {
    const current = state.value;
    if (!current) return null;
    return membersById.value.get(current.speakingOrder[current.speakerIndex] ?? "") ?? null;
  });
  const currentVoter = computed(() => {
    const current = state.value;
    if (!current) return null;
    return membersById.value.get(current.voterOrder[current.voterIndex] ?? "") ?? null;
  });

  function commit() {
    if (!state.value) return;
    state.value.updatedAt = Date.now();
    saveOfflineState(state.value);
  }

  function pickWordPair() {
    const pair = WORD_PAIRS[Math.floor(random() * WORD_PAIRS.length)];
    if (!pair) throw new Error("词库为空");
    return { ...pair };
  }

  function dealCurrentGame(current: OfflineGameState) {
    const participants = current.members.filter((member) => member.participates && !member.left);
    const roles = createRoleDeck(current.config, random);
    participants.forEach((member, index) => {
      const role = roles[index];
      if (!role) throw new Error("身份分配失败");
      member.role = role;
      member.alive = true;
      member.word = role === "CIVILIAN" ? current.wordPair.civilian : role === "UNDERCOVER" ? current.wordPair.undercover : null;
    });
    current.phase = "DEALING";
    current.dealingIndex = 0;
    current.round = 1;
    current.speakingOrder = [];
    current.speakerIndex = 0;
    current.voterOrder = [];
    current.voterIndex = 0;
    current.votes = {};
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
      schemaVersion: 1,
      phase: "DEALING",
      config: { ...setup.config },
      participantCount: setup.participantCount,
      hostId: "local-1",
      members: createMembers(setup),
      wordPair: pickWordPair(),
      round: 1,
      dealingIndex: 0,
      speakingOrder: [],
      speakerIndex: 0,
      voterOrder: [],
      voterIndex: 0,
      votes: {},
      candidateIds: [],
      runoffTallies: null,
      privacy: { mode: "PUBLIC", playerId: null, purpose: null },
      roundResult: null,
      rounds: [],
      winner: null,
      notice: null,
      startedAt: now,
      updatedAt: now,
    };
    dealCurrentGame(current);
    state.value = current;
    resumeCandidate.value = null;
    commit();
    return null;
  }

  function resume() {
    if (!resumeCandidate.value) return;
    state.value = resumeCandidate.value;
    resumeCandidate.value = null;
    commit();
  }

  function abandon() {
    state.value = null;
    resumeCandidate.value = null;
    clearOfflineState();
  }

  function beginPrivateTurn() {
    const current = state.value;
    if (!current || current.privacy.mode !== "HANDOFF") return;
    if (current.privacy.purpose === "DEALING" || current.privacy.purpose === "RECHECK") current.privacy.mode = "REVEAL";
    else current.privacy.mode = "CAST";
    commit();
  }

  function enterSpeaking(current: OfflineGameState) {
    const holders = current.members
      .filter((member): member is OfflineMember & { role: Role } => member.participates && member.alive && !member.left && member.role !== null)
      .map((member) => ({ id: member.id, role: member.role }));
    current.phase = "SPEAKING";
    current.speakingOrder = createSpeakingOrder(holders, random);
    current.speakerIndex = 0;
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
    } else {
      current.privacy = { mode: "PUBLIC", playerId: null, purpose: null };
    }
    commit();
  }

  function forceHideSecret() {
    const current = state.value;
    if (!current || (current.privacy.mode !== "REVEAL" && current.privacy.mode !== "CAST")) return;
    current.privacy.mode = "HANDOFF";
    commit();
  }

  function nextSpeaker() {
    const current = state.value;
    if (!current || current.phase !== "SPEAKING") return;
    if (current.speakerIndex < current.speakingOrder.length - 1) {
      current.speakerIndex += 1;
      commit();
      return;
    }
    beginVoting("VOTING");
  }

  function recheckIdentity(playerId: string) {
    const current = state.value;
    const member = membersById.value.get(playerId);
    if (!current || current.phase !== "SPEAKING" || !member?.alive || member.left || !member.participates) return;
    current.privacy = { mode: "HANDOFF", playerId, purpose: "RECHECK" };
    commit();
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
    }
    current.privacy = {
      mode: "HANDOFF",
      playerId: current.voterOrder[0] ?? null,
      purpose: kind,
    };
    commit();
  }

  function submitVote(targetId: string | null): string | null {
    const current = state.value;
    const voter = currentVoter.value;
    if (!current || !voter || current.privacy.mode !== "CAST") return "当前不能投票";
    if (targetId === null && aliveMembers.value.length < 4) return "仅剩三人时不能弃权";
    if (targetId !== null && (targetId === voter.id || !current.candidateIds.includes(targetId))) return "请选择有效的其他存活玩家";
    current.votes[voter.id] = targetId;
    current.voterIndex += 1;
    const next = current.voterOrder[current.voterIndex];
    if (next) {
      current.privacy = { mode: "HANDOFF", playerId: next, purpose: current.phase === "RUNOFF" ? "RUNOFF" : "VOTING" };
      commit();
    } else settleCurrentVote();
    return null;
  }

  function finishRunoff() {
    if (state.value?.phase === "RUNOFF") settleCurrentVote();
  }

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

    let eliminatedPlayerId: string | null = null;
    let reason: RoundResult["reason"] = "NO_VALID_VOTE";
    if (settlement.leaderIds.length === 1) {
      eliminatedPlayerId = settlement.leaderIds[0] ?? null;
      const eliminated = eliminatedPlayerId ? membersById.value.get(eliminatedPlayerId) : null;
      if (eliminated) eliminated.alive = false;
      reason = "ELIMINATED";
    } else if (settlement.leaderIds.length > 1) reason = "TIE";

    showResult({
      round: current.round,
      eliminatedPlayerId,
      tallies: settlement.tallies,
      abstainCount: settlement.abstainCount,
      reason,
    });
  }

  function winnerForCurrent(current: OfflineGameState) {
    return determineWinner(
      current.members
        .filter((member): member is OfflineMember & { role: Role } => member.participates && member.role !== null)
        .map((member) => ({ id: member.id, role: member.role, alive: member.alive, left: member.left })),
    );
  }

  function showResult(result: RoundResult) {
    const current = state.value;
    if (!current) return;
    current.roundResult = result;
    current.rounds.push(result);
    current.votes = {};
    current.voterOrder = [];
    current.voterIndex = 0;
    current.privacy = { mode: "PUBLIC", playerId: null, purpose: null };
    const winner = winnerForCurrent(current);
    if (winner) {
      current.winner = winner;
      current.phase = "ENDED";
    } else current.phase = "ROUND_RESULT";
    commit();
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
    member.left = true;
    member.alive = false;
    const winner = winnerForCurrent(current);
    if (winner) {
      current.winner = winner;
      current.phase = "ENDED";
      current.privacy = { mode: "PUBLIC", playerId: null, purpose: null };
      commit();
      return null;
    }
    if (current.phase === "VOTING") {
      current.notice = `${member.nickname} 已退出，本轮投票已作废，请重新投票`;
      beginVoting("VOTING");
    } else if (current.phase === "RUNOFF") {
      if (current.candidateIds.includes(playerId)) {
        showResult({ round: current.round, eliminatedPlayerId: null, tallies: [], abstainCount: 0, reason: "RUNOFF_CANCELLED" });
      } else {
        current.notice = `${member.nickname} 已退出，本轮重投已作废，请重新投票`;
        beginVoting("RUNOFF");
      }
    } else if (current.phase === "SPEAKING") {
      const leavingIndex = current.speakingOrder.indexOf(playerId);
      current.speakingOrder = current.speakingOrder.filter((id) => id !== playerId);
      if (leavingIndex >= 0 && leavingIndex < current.speakerIndex) current.speakerIndex -= 1;
      current.speakerIndex = Math.min(current.speakerIndex, Math.max(0, current.speakingOrder.length - 1));
      commit();
    } else commit();
    return null;
  }

  function rematch() {
    const current = state.value;
    if (!current || current.phase !== "ENDED") return;
    current.members.forEach((member) => {
      member.left = false;
      member.alive = member.participates;
      member.role = null;
      member.word = null;
    });
    current.wordPair = pickWordPair();
    current.startedAt = Date.now();
    dealCurrentGame(current);
    commit();
  }

  return {
    state,
    resumeCandidate,
    storageWarning,
    aliveMembers,
    membersById,
    currentPrivatePlayer,
    currentSpeaker,
    currentVoter,
    start,
    resume,
    abandon,
    beginPrivateTurn,
    hideIdentity,
    forceHideSecret,
    nextSpeaker,
    recheckIdentity,
    submitVote,
    finishRunoff,
    nextRound,
    transferHost,
    markLeft,
    rematch,
  };
}
