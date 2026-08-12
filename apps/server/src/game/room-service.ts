import { randomBytes, randomUUID } from "node:crypto";
import {
  AVATAR_IDS,
  createRoleDeck,
  createSpeakingOrder,
  determineWinner as determineGameWinner,
  filterWordPairs,
  isExplosiveMode,
  isHiddenMode,
  normalizeGuess,
  normalizedNicknameKey,
  roleConfigError,
  settleVotes as settleGameVotes,
  type AliveRoleHolder,
  type AvatarId,
  type CustomWords,
  type ErrorCode,
  type FinalResult,
  type PrivateIdentity,
  type RevealedPlayer,
  type Role,
  type RoleHolder,
  type RoomConfig,
  type RoomPhase,
  type RoomSnapshot,
  type RoundResult,
  type SelfDestructResult,
  type SessionCredentials,
  type VoteSubmission,
  type VoteTally,
  type Winner,
  type WordPair,
} from "@maskword/shared";
import { GAME_CONFIG } from "../config.js";

interface Player {
  id: string;
  nickname: string;
  normalizedNickname: string;
  resumeToken: string;
  joinedAt: number;
  socketIds: Set<string>;
  avatarId: AvatarId;
  participates: boolean;
  alive: boolean;
  left: boolean;
  role: Role | null;
  word: string | null;
  roleRevealed: boolean;
  selfDestructUsed: boolean;
}

interface SpeakingState {
  currentIndex: number;
  startedAt: number | null;
  deadlineAt: number | null;
  completedPlayerIds: Set<string>;
}

interface GameState {
  round: number;
  wordPair: WordPair;
  speakingOrder: string[];
  speaking: SpeakingState;
  votes: Map<string, string | null>;
  sealedGuesses: Map<string, string>;
  votingKind: "NORMAL" | "RUNOFF" | null;
  allowedTargetIds: Set<string>;
  runoffTallies: VoteTally[] | null;
  deadlineAt: number | null;
  currentRoundResult: RoundResult | null;
  roundResultEndsAt: number | null;
  roundResults: RoundResult[];
  winner: Winner | null;
}

interface Room {
  code: string;
  config: RoomConfig;
  customWords: CustomWords | null;
  phase: RoomPhase;
  hostId: string;
  players: Map<string, Player>;
  game: GameState | null;
  createdAt: number;
  lastActivityAt: number;
  hostDisconnectedAt: number | null;
  allOfflineSince: number | null;
}

interface ServiceCallbacks {
  onRoomUpdated?: (roomCode: string) => void;
  onRoomClosed?: (roomCode: string, reason: "DISSOLVED" | "EXPIRED", socketIds: string[]) => void;
}

interface ServiceOptions {
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class GameError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GameError";
  }
}

export class RoomService {
  private readonly rooms = new Map<string, Room>();
  private readonly sessions = new Map<string, { roomCode: string; playerId: string }>();
  private readonly voteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly resultTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly hostTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private callbacks: ServiceCallbacks = {};
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(options: ServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  setCallbacks(callbacks: ServiceCallbacks): void {
    this.callbacks = callbacks;
  }

  createRoom(nickname: string, config: RoomConfig, socketId: string, customWords?: CustomWords): SessionCredentials {
    const cleanNickname = this.validateNickname(nickname);
    this.validateConfig(config);
    const privateWords = this.validateCustomWords(config, customWords);
    const roomCode = this.generateRoomCode();
    const player = this.createPlayer(cleanNickname, config.hostParticipates, socketId, AVATAR_IDS[0]);
    const now = this.now();
    const room: Room = {
      code: roomCode,
      config: { ...config },
      customWords: privateWords,
      phase: "WAITING",
      hostId: player.id,
      players: new Map([[player.id, player]]),
      game: null,
      createdAt: now,
      lastActivityAt: now,
      hostDisconnectedAt: null,
      allOfflineSince: null,
    };

    this.rooms.set(roomCode, room);
    this.sessions.set(socketId, { roomCode, playerId: player.id });
    this.publish(room);
    return this.credentials(room, player);
  }

  joinRoom(nickname: string, rawRoomCode: string, socketId: string): SessionCredentials {
    const cleanNickname = this.validateNickname(nickname);
    const room = this.getRoom(rawRoomCode.trim());
    if (room.phase !== "WAITING") throw new GameError("GAME_IN_PROGRESS", "游戏已经开始，当前不能加入");
    if (this.activeParticipants(room).length >= this.requiredPlayerCount(room)) throw new GameError("ROOM_FULL", "房间参赛人数已满");
    const normalized = normalizedNicknameKey(cleanNickname);
    if ([...room.players.values()].some((item) => !item.left && item.normalizedNickname === normalized)) {
      throw new GameError("DUPLICATE_NICKNAME", "房间内已有相同昵称");
    }

    const avatarId = this.firstAvailableAvatar(room);
    const player = this.createPlayer(cleanNickname, true, socketId, avatarId);
    room.players.set(player.id, player);
    this.sessions.set(socketId, { roomCode: room.code, playerId: player.id });
    this.touchAndPublish(room);
    return this.credentials(room, player);
  }

  resumeRoom(credentials: SessionCredentials, socketId: string): void {
    const room = this.getRoom(credentials.roomCode, "RECOVERY_FAILED");
    const player = room.players.get(credentials.playerId);
    if (!player || player.left || player.resumeToken !== credentials.resumeToken) {
      throw new GameError("RECOVERY_FAILED", "恢复信息无效，房间可能已过期");
    }
    player.socketIds.add(socketId);
    room.allOfflineSince = null;
    this.sessions.set(socketId, { roomCode: room.code, playerId: player.id });
    if (room.hostId === player.id) {
      room.hostDisconnectedAt = null;
      this.clearRoomTimer(this.hostTimers, room.code);
    } else {
      this.transferExpiredOfflineHost(room);
    }
    this.touchAndPublish(room);
  }

  disconnect(socketId: string): void {
    const session = this.sessions.get(socketId);
    if (!session) return;
    this.sessions.delete(socketId);
    const room = this.rooms.get(session.roomCode);
    const player = room?.players.get(session.playerId);
    if (!room || !player) return;
    player.socketIds.delete(socketId);
    if (this.onlineMembers(room).length === 0 && room.allOfflineSince === null) room.allOfflineSince = this.now();
    if (room.hostId === player.id && player.socketIds.size === 0) {
      room.hostDisconnectedAt = this.now();
      this.scheduleHostTransfer(room);
    }
    this.publish(room);
  }

  leaveRoom(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    if (room.hostId === player.id) {
      this.dissolveRoom(socketId);
      return;
    }
    this.invalidatePlayerSessions(player);
    player.left = true;
    player.alive = false;
    player.socketIds.clear();
    if (room.phase === "WAITING") {
      room.players.delete(player.id);
      this.touchAndPublish(room);
      return;
    }
    if (room.game) {
      room.game.speakingOrder = room.game.speakingOrder.filter((id) => id !== player.id);
      room.game.speaking.completedPlayerIds.delete(player.id);
      room.game.sealedGuesses.delete(player.id);
    }
    const winner = this.determineWinner(room);
    if (winner) {
      this.endGame(room, winner);
      return;
    }
    if (room.phase === "VOTING") {
      this.invalidateVotesForPlayer(room, player.id);
      if (this.allEligibleVotersSubmitted(room)) this.settleVoting(room);
      else this.touchAndPublish(room);
      return;
    }
    if (room.phase === "RUNOFF" && room.game?.allowedTargetIds.has(player.id)) {
      this.finalizeVoting(room, [], 0, null, "RUNOFF_CANCELLED");
      return;
    }
    this.touchAndPublish(room);
  }

  dissolveRoom(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    this.requireHost(room, player);
    this.closeRoom(room, "DISSOLVED");
  }

  transferHost(socketId: string, targetPlayerId: string): void {
    const { room, player } = this.requireSession(socketId);
    this.requireHost(room, player);
    const target = room.players.get(targetPlayerId);
    if (!target || target.left || target.id === player.id || target.socketIds.size === 0) {
      throw new GameError("INVALID_INPUT", "只能转移给当前在线的其他成员");
    }
    room.hostId = target.id;
    room.hostDisconnectedAt = null;
    this.clearRoomTimer(this.hostTimers, room.code);
    this.touchAndPublish(room);
  }

  changeAvatar(socketId: string, avatarId: AvatarId): void {
    const { room, player } = this.requireSession(socketId);
    if (room.phase !== "WAITING") throw new GameError("INVALID_PHASE", "头像只能在开局前更换");
    if (!AVATAR_IDS.includes(avatarId)) throw new GameError("INVALID_INPUT", "头像不存在");
    if ([...room.players.values()].some((item) => !item.left && item.id !== player.id && item.avatarId === avatarId)) {
      throw new GameError("AVATAR_TAKEN", "这个头像已被其他玩家使用");
    }
    player.avatarId = avatarId;
    this.touchAndPublish(room);
  }

  startGame(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    this.requireHost(room, player);
    if (room.phase !== "WAITING") throw new GameError("INVALID_PHASE", "当前不能开始游戏");
    this.validateConfig(room.config);
    const participants = this.activeParticipants(room);
    if (participants.length !== this.requiredPlayerCount(room)) {
      throw new GameError("INVALID_CONFIG", `需要 ${this.requiredPlayerCount(room)} 名参赛者，当前为 ${participants.length} 名`);
    }
    const pool = filterWordPairs(room.config.wordCategory, room.config.wordDifficulty);
    const pair = room.customWords
      ? { ...room.customWords, category: room.config.wordCategory, difficulty: room.config.wordDifficulty, audience: "GENERAL" as const }
      : this.pickWordPair(pool);
    const roles = createRoleDeck(room.config, this.random);
    participants.forEach((participant, index) => {
      const role = roles[index];
      if (!role) throw new GameError("INTERNAL_ERROR", "身份分配失败");
      participant.role = role;
      participant.word = role === "CIVILIAN" ? pair.civilian : role === "BLANK" ? null : pair.undercover;
      participant.alive = true;
      participant.roleRevealed = !isHiddenMode(room.config.mode);
      participant.selfDestructUsed = false;
    });
    const speakingOrder = this.generateSpeakingOrder(participants);
    room.game = {
      round: 1,
      wordPair: pair,
      speakingOrder,
      speaking: this.newSpeakingState(),
      votes: new Map(),
      sealedGuesses: new Map(),
      votingKind: null,
      allowedTargetIds: new Set(),
      runoffTallies: null,
      deadlineAt: null,
      currentRoundResult: null,
      roundResultEndsAt: null,
      roundResults: [],
      winner: null,
    };
    room.phase = "SPEAKING";
    this.touchAndPublish(room);
  }

  startSpeaking(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    const game = room.game;
    if (!game || room.phase !== "SPEAKING") throw new GameError("INVALID_PHASE", "当前不在发言阶段");
    const currentId = this.currentSpeakerId(room);
    if (player.id !== currentId) throw new GameError("UNAUTHORIZED", "只有当前玩家可以开始发言");
    if (game.speaking.startedAt !== null) throw new GameError("INVALID_PHASE", "发言已经开始");
    game.speaking.startedAt = this.now();
    game.speaking.deadlineAt = room.config.speakingSeconds > 0
      ? game.speaking.startedAt + room.config.speakingSeconds * 1_000
      : null;
    this.touchAndPublish(room);
  }

  endSpeaking(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    const game = room.game;
    if (!game || room.phase !== "SPEAKING") throw new GameError("INVALID_PHASE", "当前不在发言阶段");
    const currentId = this.currentSpeakerId(room);
    if (player.id !== currentId && player.id !== room.hostId) throw new GameError("UNAUTHORIZED", "只有当前玩家或房主可以结束发言");
    if (currentId) game.speaking.completedPlayerIds.add(currentId);
    game.speaking.currentIndex += 1;
    game.speaking.startedAt = null;
    game.speaking.deadlineAt = null;
    this.skipUnavailableSpeakers(room);
    this.touchAndPublish(room);
  }

  beginVote(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    this.requireHost(room, player);
    if (room.phase !== "SPEAKING" || !room.game) throw new GameError("INVALID_PHASE", "当前不能进入投票");
    const alive = this.alivePlayers(room);
    room.phase = "VOTING";
    room.game.votes.clear();
    room.game.sealedGuesses.clear();
    room.game.votingKind = "NORMAL";
    room.game.allowedTargetIds = new Set(alive.map((candidate) => candidate.id));
    room.game.runoffTallies = null;
    room.game.deadlineAt = this.now() + GAME_CONFIG.normalVoteDurationMs;
    this.revealEligibleHiddenRoles(room);
    this.scheduleVoteTimeout(room);
    this.touchAndPublish(room);
  }

  submitVote(socketId: string, submission: VoteSubmission): void {
    const { room, player } = this.requireSession(socketId);
    const game = room.game;
    if (!game || (room.phase !== "VOTING" && room.phase !== "RUNOFF")) throw new GameError("INVALID_PHASE", "当前不在投票阶段");
    if (!player.participates || !player.alive || player.left) throw new GameError("INVALID_VOTE", "你当前没有投票资格");
    if (game.votes.has(player.id)) throw new GameError("ALREADY_VOTED", "本轮已经提交过投票");
    this.validateVoteTarget(room, player, submission.targetPlayerId);
    const guess = submission.guess?.trim();
    if (game.votingKind === "RUNOFF" && guess) throw new GameError("SELF_DESTRUCT_UNAVAILABLE", "平票重投不能新增或修改自爆猜词");
    if (guess) {
      if (player.selfDestructUsed) throw new GameError("SELF_DESTRUCT_USED", "你的自爆猜词机会已使用");
      if (!this.canSelfDestruct(room, player)) throw new GameError("SELF_DESTRUCT_UNAVAILABLE", "当前不具备自爆猜词资格");
      if ([...guess].length > 12) throw new GameError("INVALID_INPUT", "猜测词语长度需要为 1–12 个字符");
    }
    // 选票和猜词通过同一个事件在所有校验通过后一次写入。
    game.votes.set(player.id, submission.targetPlayerId);
    if (guess) {
      game.sealedGuesses.set(player.id, guess);
      player.selfDestructUsed = true;
    }
    if (this.allEligibleVotersSubmitted(room)) this.settleVoting(room);
    else this.touchAndPublish(room);
  }

  finishRunoff(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    this.requireHost(room, player);
    if (room.phase !== "RUNOFF") throw new GameError("INVALID_PHASE", "当前没有平票重投");
    this.settleVoting(room);
  }

  advanceRound(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    this.requireHost(room, player);
    if (room.phase !== "ROUND_RESULT" || room.config.resultAdvance !== "MANUAL") {
      throw new GameError("INVALID_PHASE", "当前不能手动进入下一轮");
    }
    this.goToNextRound(room.code);
  }

  rematch(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    this.requireHost(room, player);
    if (room.phase !== "ENDED") throw new GameError("INVALID_PHASE", "当前不能再来一局");
    for (const [playerId, member] of room.players) {
      if (member.left) {
        room.players.delete(playerId);
        continue;
      }
      member.alive = member.participates;
      member.role = null;
      member.word = null;
      member.roleRevealed = false;
      member.selfDestructUsed = false;
    }
    room.game = null;
    room.phase = "WAITING";
    this.touchAndPublish(room);
  }

  snapshotForSocket(socketId: string): RoomSnapshot {
    const { room, player } = this.requireSession(socketId);
    return this.snapshot(room, player);
  }

  snapshotsForRoom(roomCode: string): Array<{ socketId: string; snapshot: RoomSnapshot }> {
    const room = this.rooms.get(roomCode);
    if (!room) return [];
    return [...room.players.values()].flatMap((player) =>
      player.left ? [] : [...player.socketIds].map((socketId) => ({ socketId, snapshot: this.snapshot(room, player) })),
    );
  }

  cleanupExpiredRooms(): void {
    const now = this.now();
    for (const room of this.rooms.values()) {
      let ttl = Number.POSITIVE_INFINITY;
      if (room.phase === "WAITING") ttl = GAME_CONFIG.waitingRoomTtlMs;
      else if (room.phase === "ENDED") ttl = GAME_CONFIG.endedRoomTtlMs;
      else if (this.onlineMembers(room).length === 0) {
        const offlineSince = room.allOfflineSince ?? now;
        if (now - offlineSince >= GAME_CONFIG.allOfflineGameTtlMs) this.closeRoom(room, "EXPIRED");
        continue;
      }
      if (now - room.lastActivityAt >= ttl) this.closeRoom(room, "EXPIRED");
    }
  }

  getRoomCount(): number {
    return this.rooms.size;
  }

  private settleVoting(room: Room): void {
    const game = room.game;
    if (!game?.votingKind) throw new GameError("INVALID_PHASE", "当前没有可结算的投票");
    this.clearRoomTimer(this.voteTimers, room.code);
    const { tallies, abstainCount, leaderIds } = settleGameVotes(
      [...game.allowedTargetIds],
      this.eligibleVoters(room).map((item) => item.id),
      Object.fromEntries(game.votes),
    );
    if (game.votingKind === "NORMAL" && leaderIds.length > 1) {
      room.phase = "RUNOFF";
      game.votes.clear();
      game.votingKind = "RUNOFF";
      game.allowedTargetIds = new Set(leaderIds);
      game.runoffTallies = tallies.filter((item) => leaderIds.includes(item.playerId));
      game.deadlineAt = null;
      this.touchAndPublish(room);
      return;
    }
    const voteEliminatedPlayerId = leaderIds.length === 1 ? leaderIds[0] ?? null : null;
    const reason: RoundResult["reason"] = leaderIds.length === 1 ? "ELIMINATED" : leaderIds.length > 1 ? "TIE" : "NO_VALID_VOTE";
    this.finalizeVoting(room, tallies, abstainCount, voteEliminatedPlayerId, reason);
  }

  private finalizeVoting(
    room: Room,
    tallies: VoteTally[],
    abstainCount: number,
    voteEliminatedPlayerId: string | null,
    fallbackReason: RoundResult["reason"],
  ): void {
    const game = room.game;
    if (!game) return;
    const selfDestructResults: SelfDestructResult[] = [...game.sealedGuesses].flatMap(([playerId, guess]) => {
      const player = room.players.get(playerId);
      if (!player || (player.role !== "UNDERCOVER" && player.role !== "DOUBLE_AGENT")) return [];
      return [{ playerId, role: player.role, guess, correct: normalizeGuess(guess) === normalizeGuess(game.wordPair.civilian) }];
    });
    const anyCorrect = selfDestructResults.some((item) => item.correct);
    const eliminatedIds = new Set<string>();
    if (!anyCorrect) {
      for (const result of selfDestructResults) if (!result.correct) eliminatedIds.add(result.playerId);
      if (voteEliminatedPlayerId) eliminatedIds.add(voteEliminatedPlayerId);
      for (const playerId of eliminatedIds) {
        const player = room.players.get(playerId);
        if (player) player.alive = false;
      }
    }
    const result: RoundResult = {
      round: game.round,
      eliminatedPlayerIds: [...eliminatedIds],
      voteEliminatedPlayerId: anyCorrect ? null : voteEliminatedPlayerId,
      selfDestructResults,
      tallies,
      abstainCount,
      reason: eliminatedIds.size > 1 ? "MULTIPLE_ELIMINATED" : eliminatedIds.size === 1 ? "ELIMINATED" : fallbackReason,
    };
    this.clearVoteState(room);
    game.sealedGuesses.clear();
    game.roundResults.push(result);
    game.currentRoundResult = result;
    if (anyCorrect) {
      this.endGame(room, "UNDERCOVER");
      return;
    }
    this.revealActivatedDoubleAgents(room);
    const winner = this.determineWinner(room);
    if (winner) {
      this.endGame(room, winner);
      return;
    }
    this.showRoundResult(room);
  }

  private showRoundResult(room: Room): void {
    if (!room.game) return;
    room.phase = "ROUND_RESULT";
    this.clearRoomTimer(this.resultTimers, room.code);
    if (room.config.resultAdvance === "AUTO") {
      room.game.roundResultEndsAt = this.now() + GAME_CONFIG.roundResultDurationMs;
      const timer = this.setTimer(() => this.goToNextRound(room.code), GAME_CONFIG.roundResultDurationMs);
      this.resultTimers.set(room.code, timer);
    } else {
      room.game.roundResultEndsAt = null;
    }
    this.touchAndPublish(room);
  }

  private goToNextRound(roomCode: string): void {
    this.clearRoomTimer(this.resultTimers, roomCode);
    const room = this.rooms.get(roomCode);
    if (!room?.game || room.phase !== "ROUND_RESULT") return;
    room.game.round += 1;
    room.game.currentRoundResult = null;
    room.game.roundResultEndsAt = null;
    room.game.speakingOrder = this.generateSpeakingOrder(this.alivePlayers(room));
    room.game.speaking = this.newSpeakingState();
    room.phase = "SPEAKING";
    this.touchAndPublish(room);
  }

  private endGame(room: Room, winner: Winner): void {
    if (!room.game) return;
    this.clearRoomTimer(this.voteTimers, room.code);
    this.clearRoomTimer(this.resultTimers, room.code);
    room.game.winner = winner;
    room.game.votingKind = null;
    room.game.deadlineAt = null;
    room.game.roundResultEndsAt = null;
    room.phase = "ENDED";
    this.touchAndPublish(room);
  }

  private determineWinner(room: Room): Winner | null {
    if (!room.game) return null;
    return determineGameWinner(
      this.activeParticipants(room)
        .filter((item): item is Player & { role: Role } => item.role !== null)
        .map((item): AliveRoleHolder => ({ id: item.id, role: item.role, alive: item.alive, left: item.left })),
    );
  }

  private snapshot(room: Room, self: Player): RoomSnapshot {
    const game = room.game;
    const eligibleVoters = this.eligibleVoters(room);
    const isHost = room.hostId === self.id;
    const canVote = Boolean(
      game && (room.phase === "VOTING" || room.phase === "RUNOFF") && self.participates && self.alive && !self.left && !game.votes.has(self.id),
    );
    const identityAvailable = Boolean(self.role && game);
    const privateIdentity: PrivateIdentity | null = identityAvailable
      ? {
          role: self.roleRevealed ? self.role : null,
          word: self.word,
          roleRevealed: self.roleRevealed,
          selfDestruct: {
            eligible: this.canSelfDestruct(room, self),
            used: self.selfDestructUsed,
            sealed: Boolean(game?.sealedGuesses.has(self.id)),
          },
        }
      : null;
    const currentSpeakerId = this.currentSpeakerId(room);
    return {
      roomCode: room.code,
      phase: room.phase,
      config: { ...room.config },
      hostId: room.hostId,
      selfId: self.id,
      round: game?.round ?? 0,
      requiredPlayerCount: this.requiredPlayerCount(room),
      participatingPlayerCount: this.activeParticipants(room).length,
      players: [...room.players.values()]
        .filter((item) => !item.left)
        .sort((left, right) => left.joinedAt - right.joinedAt)
        .map((item) => ({
          id: item.id,
          nickname: item.nickname,
          avatarId: item.avatarId,
          isHost: item.id === room.hostId,
          isOnline: item.socketIds.size > 0,
          isParticipating: item.participates,
          isAlive: item.alive,
          hasSubmittedVote: item.id === self.id ? Boolean(game?.votes.has(item.id)) : false,
        })),
      speakingOrder: game?.speakingOrder ?? [],
      speaking: game
        ? {
            currentPlayerId: currentSpeakerId,
            startedAt: game.speaking.startedAt,
            deadlineAt: game.speaking.deadlineAt,
            completedPlayerIds: [...game.speaking.completedPlayerIds],
          }
        : null,
      privateIdentity,
      voting: game?.votingKind
        ? {
            kind: game.votingKind,
            submittedCount: game.votes.size,
            eligibleCount: eligibleVoters.length,
            candidateIds: [...game.allowedTargetIds],
            allowedTargetIds: canVote ? [...game.allowedTargetIds].filter((id) => id !== self.id) : [],
            runoffTallies: game.votingKind === "RUNOFF" ? game.runoffTallies : null,
            canVote,
            canAbstain: canVote && this.alivePlayers(room).length >= 4,
            canGuess: canVote && this.canSelfDestruct(room, self),
            deadlineAt: game.deadlineAt,
          }
        : null,
      roundResult: game?.currentRoundResult ?? null,
      roundResultEndsAt: room.phase === "ROUND_RESULT" ? game?.roundResultEndsAt ?? null : null,
      finalResult: room.phase === "ENDED" ? this.finalResult(room) : null,
      permissions: {
        canStart: isHost && room.phase === "WAITING" && this.activeParticipants(room).length === this.requiredPlayerCount(room),
        canBeginVote: isHost && room.phase === "SPEAKING",
        canStartSpeaking: room.phase === "SPEAKING" && self.id === currentSpeakerId && game?.speaking.startedAt === null,
        canEndSpeaking: room.phase === "SPEAKING" && Boolean(currentSpeakerId) && (self.id === currentSpeakerId || isHost),
        canAdvanceRound: isHost && room.phase === "ROUND_RESULT" && room.config.resultAdvance === "MANUAL",
        canFinishRunoff: isHost && room.phase === "RUNOFF",
        canTransferHost: isHost && this.onlineMembers(room).some((item) => item.id !== self.id),
        canRematch: isHost && room.phase === "ENDED",
        canDissolve: isHost,
        canChangeAvatar: room.phase === "WAITING",
      },
    };
  }

  private finalResult(room: Room): FinalResult | null {
    const game = room.game;
    if (!game?.winner) return null;
    const players: RevealedPlayer[] = [...room.players.values()]
      .filter((item) => item.role !== null)
      .sort((left, right) => left.joinedAt - right.joinedAt)
      .map((item) => ({
        id: item.id,
        nickname: item.nickname,
        avatarId: item.avatarId,
        role: item.role as Role,
        isAlive: item.alive,
        hasLeft: item.left,
      }));
    return {
      winner: game.winner,
      civilianWord: game.wordPair.civilian,
      undercoverWord: game.wordPair.undercover,
      players,
      rounds: game.roundResults,
    };
  }

  private canSelfDestruct(room: Room, player: Player): boolean {
    const game = room.game;
    if (!game || room.phase !== "VOTING" || game.votingKind !== "NORMAL" || !isExplosiveMode(room.config.mode)) return false;
    if (!player.alive || player.left || player.selfDestructUsed || game.round < room.config.selfDestructRound) return false;
    if (player.role === "UNDERCOVER") return true;
    return player.role === "DOUBLE_AGENT" && !this.hasAliveOrdinaryUndercover(room);
  }

  private revealEligibleHiddenRoles(room: Room): void {
    if (!isHiddenMode(room.config.mode) || !isExplosiveMode(room.config.mode) || !room.game) return;
    if (room.game.round >= room.config.selfDestructRound) {
      for (const player of this.alivePlayers(room)) if (player.role === "UNDERCOVER") player.roleRevealed = true;
    }
    this.revealActivatedDoubleAgents(room);
  }

  private revealActivatedDoubleAgents(room: Room): void {
    if (!isHiddenMode(room.config.mode) || this.hasAliveOrdinaryUndercover(room)) return;
    for (const player of this.alivePlayers(room)) if (player.role === "DOUBLE_AGENT") player.roleRevealed = true;
  }

  private hasAliveOrdinaryUndercover(room: Room): boolean {
    return this.alivePlayers(room).some((item) => item.role === "UNDERCOVER");
  }

  private validateVoteTarget(room: Room, player: Player, targetId: string | null): void {
    const game = room.game;
    if (!game) throw new GameError("INVALID_PHASE", "当前不在投票阶段");
    if (targetId === null) {
      if (this.alivePlayers(room).length < 4) throw new GameError("INVALID_VOTE", "仅剩三人时不能弃权");
      return;
    }
    if (targetId === player.id || !game.allowedTargetIds.has(targetId)) {
      throw new GameError("INVALID_VOTE", "请选择有效的其他存活玩家");
    }
  }

  private validateCustomWords(config: RoomConfig, words?: CustomWords): CustomWords | null {
    if (!words) return null;
    if (config.hostParticipates) throw new GameError("INVALID_CONFIG", "只有不参赛的主持人可以自定义词语");
    const civilian = words.civilian.trim();
    const undercover = words.undercover.trim();
    if (![civilian, undercover].every((word) => [...word].length >= 1 && [...word].length <= 12)) {
      throw new GameError("INVALID_CONFIG", "自定义词语长度需要为 1–12 个字符");
    }
    if (normalizeGuess(civilian) === normalizeGuess(undercover)) throw new GameError("INVALID_CONFIG", "平民词和卧底词不能相同");
    return { civilian, undercover };
  }

  private validateConfig(config: RoomConfig): void {
    const error = roleConfigError(config);
    if (error) throw new GameError("INVALID_CONFIG", error);
    if (!filterWordPairs(config.wordCategory, config.wordDifficulty).length) throw new GameError("WORD_POOL_EMPTY", "当前词库筛选结果为空");
  }

  private pickWordPair(items: readonly WordPair[]): WordPair {
    const item = items[Math.floor(this.random() * items.length)];
    if (!item) throw new GameError("WORD_POOL_EMPTY", "当前词库筛选结果为空");
    return item;
  }

  private currentSpeakerId(room: Room): string | null {
    if (!room.game || room.phase !== "SPEAKING") return null;
    this.skipUnavailableSpeakers(room);
    return room.game.speakingOrder[room.game.speaking.currentIndex] ?? null;
  }

  private skipUnavailableSpeakers(room: Room): void {
    const game = room.game;
    if (!game) return;
    while (game.speaking.currentIndex < game.speakingOrder.length) {
      const player = room.players.get(game.speakingOrder[game.speaking.currentIndex] ?? "");
      if (player?.alive && !player.left) break;
      game.speaking.currentIndex += 1;
    }
  }

  private newSpeakingState(): SpeakingState {
    return { currentIndex: 0, startedAt: null, deadlineAt: null, completedPlayerIds: new Set() };
  }

  private invalidateVotesForPlayer(room: Room, playerId: string): void {
    const game = room.game;
    if (!game) return;
    game.votes.delete(playerId);
    for (const [voterId, targetId] of game.votes) if (targetId === playerId) game.votes.delete(voterId);
    game.allowedTargetIds.delete(playerId);
  }

  private scheduleVoteTimeout(room: Room): void {
    this.clearRoomTimer(this.voteTimers, room.code);
    const timer = this.setTimer(() => {
      this.voteTimers.delete(room.code);
      const current = this.rooms.get(room.code);
      if (current?.phase === "VOTING") this.settleVoting(current);
    }, GAME_CONFIG.normalVoteDurationMs);
    this.voteTimers.set(room.code, timer);
  }

  private scheduleHostTransfer(room: Room): void {
    this.clearRoomTimer(this.hostTimers, room.code);
    const timer = this.setTimer(() => {
      this.hostTimers.delete(room.code);
      const current = this.rooms.get(room.code);
      if (current) this.transferExpiredOfflineHost(current);
    }, GAME_CONFIG.hostTransferDelayMs);
    this.hostTimers.set(room.code, timer);
  }

  private transferExpiredOfflineHost(room: Room): void {
    const host = room.players.get(room.hostId);
    if (!host || host.socketIds.size > 0 || room.hostDisconnectedAt === null) return;
    if (this.now() - room.hostDisconnectedAt < GAME_CONFIG.hostTransferDelayMs) return;
    const successor = this.onlineMembers(room)
      .filter((item) => item.id !== host.id)
      .sort((left, right) => left.joinedAt - right.joinedAt)[0];
    if (!successor) return;
    room.hostId = successor.id;
    room.hostDisconnectedAt = null;
    this.touchAndPublish(room);
  }

  private closeRoom(room: Room, reason: "DISSOLVED" | "EXPIRED"): void {
    const socketIds = [...room.players.values()].flatMap((item) => [...item.socketIds]);
    for (const player of room.players.values()) this.invalidatePlayerSessions(player);
    this.clearRoomTimer(this.voteTimers, room.code);
    this.clearRoomTimer(this.resultTimers, room.code);
    this.clearRoomTimer(this.hostTimers, room.code);
    this.rooms.delete(room.code);
    this.callbacks.onRoomClosed?.(room.code, reason, socketIds);
  }

  private clearVoteState(room: Room): void {
    if (!room.game) return;
    room.game.votes.clear();
    room.game.votingKind = null;
    room.game.allowedTargetIds.clear();
    room.game.runoffTallies = null;
    room.game.deadlineAt = null;
  }

  private allEligibleVotersSubmitted(room: Room): boolean {
    const votes = room.game?.votes;
    return Boolean(votes && this.eligibleVoters(room).every((item) => votes.has(item.id)));
  }

  private eligibleVoters(room: Room): Player[] {
    return this.alivePlayers(room);
  }

  private alivePlayers(room: Room): Player[] {
    return [...room.players.values()].filter((item) => item.participates && item.alive && !item.left);
  }

  private activeParticipants(room: Room): Player[] {
    return [...room.players.values()].filter((item) => item.participates && !item.left);
  }

  private onlineMembers(room: Room): Player[] {
    return [...room.players.values()].filter((item) => !item.left && item.socketIds.size > 0);
  }

  private requiredPlayerCount(room: Room): number {
    const config = room.config;
    return config.civilianCount + config.undercoverCount + config.blankCount + config.doubleAgentCount;
  }

  private generateSpeakingOrder(players: Player[]): string[] {
    return createSpeakingOrder(
      players
        .filter((item): item is Player & { role: Role } => item.role !== null)
        .map((item): RoleHolder => ({ id: item.id, role: item.role })),
      this.random,
    );
  }

  private firstAvailableAvatar(room: Room): AvatarId {
    const occupied = new Set([...room.players.values()].filter((item) => !item.left).map((item) => item.avatarId));
    const avatar = AVATAR_IDS.find((item) => !occupied.has(item));
    if (!avatar) throw new GameError("ROOM_FULL", "房间可用头像已用完");
    return avatar;
  }

  private createPlayer(nickname: string, participates: boolean, socketId: string, avatarId: AvatarId): Player {
    return {
      id: randomUUID(),
      nickname,
      normalizedNickname: normalizedNicknameKey(nickname),
      resumeToken: randomBytes(32).toString("base64url"),
      joinedAt: this.now(),
      socketIds: new Set([socketId]),
      avatarId,
      participates,
      alive: participates,
      left: false,
      role: null,
      word: null,
      roleRevealed: false,
      selfDestructUsed: false,
    };
  }

  private credentials(room: Room, player: Player): SessionCredentials {
    return { roomCode: room.code, playerId: player.id, resumeToken: player.resumeToken };
  }

  private validateNickname(value: string): string {
    const clean = value.trim().replace(/\s+/g, " ");
    if (!clean || [...clean].length > GAME_CONFIG.nicknameMaxLength) {
      throw new GameError("INVALID_INPUT", `昵称长度需要为 1–${GAME_CONFIG.nicknameMaxLength} 个字符`);
    }
    return clean;
  }

  private getRoom(roomCode: string, missingCode: ErrorCode = "ROOM_NOT_FOUND"): Room {
    const room = this.rooms.get(roomCode);
    if (!room) throw new GameError(missingCode, "房间已过期或已解散");
    return room;
  }

  private requireSession(socketId: string): { room: Room; player: Player } {
    const session = this.sessions.get(socketId);
    if (!session) throw new GameError("UNAUTHORIZED", "请先加入房间");
    const room = this.getRoom(session.roomCode);
    const player = room.players.get(session.playerId);
    if (!player || player.left) throw new GameError("UNAUTHORIZED", "玩家状态已失效");
    return { room, player };
  }

  private requireHost(room: Room, player: Player): void {
    if (room.hostId !== player.id) throw new GameError("UNAUTHORIZED", "只有房主可以执行此操作");
  }

  private generateRoomCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = String(Math.floor(100000 + this.random() * 900000));
      if (!this.rooms.has(code)) return code;
    }
    throw new GameError("INTERNAL_ERROR", "暂时无法生成房间号，请稍后重试");
  }

  private invalidatePlayerSessions(player: Player): void {
    for (const socketId of player.socketIds) this.sessions.delete(socketId);
  }

  private clearRoomTimer(timers: Map<string, ReturnType<typeof setTimeout>>, roomCode: string): void {
    const timer = timers.get(roomCode);
    if (timer) this.clearTimer(timer);
    timers.delete(roomCode);
  }

  private touchAndPublish(room: Room): void {
    room.lastActivityAt = this.now();
    this.publish(room);
  }

  private publish(room: Room): void {
    this.callbacks.onRoomUpdated?.(room.code);
  }
}
