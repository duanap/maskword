import { randomBytes, randomUUID } from "node:crypto";
import {
  WORD_PAIRS,
  createRoleDeck,
  createSpeakingOrder,
  determineWinner as determineGameWinner,
  normalizedNicknameKey,
  roleConfigError,
  settleVotes as settleGameVotes,
  type WordPair,
  type AliveRoleHolder,
  type RoleHolder,
} from "@maskword/shared";
import type {
  ErrorCode,
  FinalResult,
  PrivateIdentity,
  RevealedPlayer,
  Role,
  RoomConfig,
  RoomPhase,
  RoomSnapshot,
  RoundResult,
  SessionCredentials,
  VoteTally,
  Winner,
} from "@maskword/shared";
import { GAME_CONFIG } from "../config.js";

interface Player {
  id: string;
  nickname: string;
  normalizedNickname: string;
  resumeToken: string;
  joinedAt: number;
  socketIds: Set<string>;
  participates: boolean;
  alive: boolean;
  left: boolean;
  role: Role | null;
  word: string | null;
}

interface GameState {
  round: number;
  wordPair: WordPair;
  speakingOrder: string[];
  votes: Map<string, string | null>;
  votingKind: "NORMAL" | "RUNOFF" | null;
  allowedTargetIds: Set<string>;
  runoffTallies: VoteTally[] | null;
  deadlineAt: number | null;
  currentRoundResult: RoundResult | null;
  roundResults: RoundResult[];
  winner: Winner | null;
}

interface Room {
  code: string;
  config: RoomConfig;
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

  createRoom(nickname: string, config: RoomConfig, socketId: string): SessionCredentials {
    const cleanNickname = this.validateNickname(nickname);
    this.validateConfig(config);
    const roomCode = this.generateRoomCode();
    const player = this.createPlayer(cleanNickname, config.hostParticipates, socketId);
    const now = this.now();
    const room: Room = {
      code: roomCode,
      config: { ...config },
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
    const roomCode = rawRoomCode.trim();
    const room = this.getRoom(roomCode);
    if (room.phase !== "WAITING") {
      throw new GameError("GAME_IN_PROGRESS", "游戏已经开始，当前不能加入");
    }
    if (this.activeParticipants(room).length >= this.requiredPlayerCount(room)) {
      throw new GameError("ROOM_FULL", "房间参赛人数已满");
    }
    const normalized = this.normalizeNickname(cleanNickname);
    if ([...room.players.values()].some((player) => !player.left && player.normalizedNickname === normalized)) {
      throw new GameError("DUPLICATE_NICKNAME", "房间内已有相同昵称");
    }

    const player = this.createPlayer(cleanNickname, true, socketId);
    room.players.set(player.id, player);
    this.sessions.set(socketId, { roomCode, playerId: player.id });
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

    const winner = this.determineWinner(room);
    if (winner) {
      this.endGame(room, winner);
      return;
    }

    if (room.phase === "VOTING") {
      room.game?.votes.delete(player.id);
      for (const [voterId, targetId] of room.game?.votes ?? []) {
        if (targetId === player.id) room.game?.votes.delete(voterId);
      }
      room.game?.allowedTargetIds.delete(player.id);
      if (this.allEligibleVotersSubmitted(room)) this.settleVoting(room);
    } else if (room.phase === "RUNOFF" && room.game?.allowedTargetIds.has(player.id)) {
      this.clearVoteState(room);
      this.showRoundResult(room, {
        round: room.game.round,
        eliminatedPlayerId: null,
        tallies: [],
        abstainCount: 0,
        reason: "RUNOFF_CANCELLED",
      });
    } else {
      if (room.game) room.game.speakingOrder = room.game.speakingOrder.filter((id) => id !== player.id);
      this.touchAndPublish(room);
    }
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

  startGame(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    this.requireHost(room, player);
    if (room.phase !== "WAITING") throw new GameError("INVALID_PHASE", "当前不能开始游戏");
    this.validateConfig(room.config);
    const participants = this.activeParticipants(room);
    if (participants.length !== this.requiredPlayerCount(room)) {
      throw new GameError("INVALID_CONFIG", `需要 ${this.requiredPlayerCount(room)} 名参赛者，当前为 ${participants.length} 名`);
    }

    const pair = this.pick(WORD_PAIRS);
    const roles = createRoleDeck(room.config, this.random);
    participants.forEach((participant, index) => {
      const role = roles[index];
      if (!role) throw new GameError("INTERNAL_ERROR", "身份分配失败");
      participant.role = role;
      participant.word = role === "CIVILIAN" ? pair.civilian : role === "UNDERCOVER" ? pair.undercover : null;
      participant.alive = true;
    });

    room.game = {
      round: 1,
      wordPair: pair,
      speakingOrder: this.generateSpeakingOrder(participants),
      votes: new Map(),
      votingKind: null,
      allowedTargetIds: new Set(),
      runoffTallies: null,
      deadlineAt: null,
      currentRoundResult: null,
      roundResults: [],
      winner: null,
    };
    room.phase = "SPEAKING";
    this.touchAndPublish(room);
  }

  beginVote(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    this.requireHost(room, player);
    if (room.phase !== "SPEAKING" || !room.game) {
      throw new GameError("INVALID_PHASE", "当前不能进入投票");
    }
    const alive = this.alivePlayers(room);
    room.phase = "VOTING";
    room.game.votes.clear();
    room.game.votingKind = "NORMAL";
    room.game.allowedTargetIds = new Set(alive.map((candidate) => candidate.id));
    room.game.runoffTallies = null;
    room.game.deadlineAt = this.now() + GAME_CONFIG.normalVoteDurationMs;
    this.scheduleVoteTimeout(room);
    this.touchAndPublish(room);
  }

  submitVote(socketId: string, targetPlayerId: string | null): void {
    const { room, player } = this.requireSession(socketId);
    const game = room.game;
    if (!game || (room.phase !== "VOTING" && room.phase !== "RUNOFF")) {
      throw new GameError("INVALID_PHASE", "当前不在投票阶段");
    }
    if (!player.participates || !player.alive || player.left) {
      throw new GameError("INVALID_VOTE", "你当前没有投票资格");
    }
    if (game.votes.has(player.id)) throw new GameError("ALREADY_VOTED", "本轮已经提交过投票");
    if (targetPlayerId === null) {
      if (this.alivePlayers(room).length < 4) throw new GameError("INVALID_VOTE", "仅剩三人时不能弃权");
    } else {
      if (targetPlayerId === player.id || !game.allowedTargetIds.has(targetPlayerId)) {
        throw new GameError("INVALID_VOTE", "请选择有效的其他存活玩家");
      }
    }

    game.votes.set(player.id, targetPlayerId);
    if (this.allEligibleVotersSubmitted(room)) {
      this.settleVoting(room);
    } else {
      this.touchAndPublish(room);
    }
  }

  finishRunoff(socketId: string): void {
    const { room, player } = this.requireSession(socketId);
    this.requireHost(room, player);
    if (room.phase !== "RUNOFF") throw new GameError("INVALID_PHASE", "当前没有平票重投");
    this.settleVoting(room);
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
    const snapshots: Array<{ socketId: string; snapshot: RoomSnapshot }> = [];
    for (const player of room.players.values()) {
      if (player.left) continue;
      for (const socketId of player.socketIds) snapshots.push({ socketId, snapshot: this.snapshot(room, player) });
    }
    return snapshots;
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
    if (!game || !game.votingKind) throw new GameError("INVALID_PHASE", "当前没有可结算的投票");
    this.clearRoomTimer(this.voteTimers, room.code);

    const voteRecord = Object.fromEntries(game.votes);
    const { tallies, abstainCount, leaderIds: leaders } = settleGameVotes(
      [...game.allowedTargetIds],
      this.eligibleVoters(room).map((player) => player.id),
      voteRecord,
    );

    if (game.votingKind === "NORMAL" && leaders.length > 1) {
      room.phase = "RUNOFF";
      game.votes.clear();
      game.votingKind = "RUNOFF";
      game.allowedTargetIds = new Set(leaders);
      game.runoffTallies = tallies.filter((item) => leaders.includes(item.playerId));
      game.deadlineAt = null;
      this.touchAndPublish(room);
      return;
    }

    let eliminatedPlayerId: string | null = null;
    let reason: RoundResult["reason"] = "NO_VALID_VOTE";
    if (leaders.length === 1) {
      eliminatedPlayerId = leaders[0] ?? null;
      const eliminated = eliminatedPlayerId ? room.players.get(eliminatedPlayerId) : undefined;
      if (eliminated) eliminated.alive = false;
      reason = "ELIMINATED";
    } else if (leaders.length > 1) {
      reason = "TIE";
    }

    this.clearVoteState(room);
    const result: RoundResult = { round: game.round, eliminatedPlayerId, tallies, abstainCount, reason };
    const winner = this.determineWinner(room);
    if (winner) {
      game.roundResults.push(result);
      game.currentRoundResult = result;
      this.endGame(room, winner);
    } else {
      this.showRoundResult(room, result);
    }
  }

  private showRoundResult(room: Room, result: RoundResult): void {
    if (!room.game) return;
    room.game.roundResults.push(result);
    room.game.currentRoundResult = result;
    room.phase = "ROUND_RESULT";
    this.clearRoomTimer(this.resultTimers, room.code);
    const timer = this.setTimer(() => this.advanceRound(room.code), GAME_CONFIG.roundResultDurationMs);
    this.resultTimers.set(room.code, timer);
    this.touchAndPublish(room);
  }

  private advanceRound(roomCode: string): void {
    this.resultTimers.delete(roomCode);
    const room = this.rooms.get(roomCode);
    if (!room?.game || room.phase !== "ROUND_RESULT") return;
    room.game.round += 1;
    room.game.currentRoundResult = null;
    room.game.speakingOrder = this.generateSpeakingOrder(this.alivePlayers(room));
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
    room.phase = "ENDED";
    this.touchAndPublish(room);
  }

  private determineWinner(room: Room): Winner | null {
    if (!room.game) return null;
    return determineGameWinner(
      this.activeParticipants(room)
        .filter((player): player is Player & { role: Role } => player.role !== null)
        .map((player): AliveRoleHolder => ({ id: player.id, role: player.role, alive: player.alive, left: player.left })),
    );
  }

  private snapshot(room: Room, self: Player): RoomSnapshot {
    const game = room.game;
    const eligibleVoters = this.eligibleVoters(room);
    const isHost = room.hostId === self.id;
    const canVote = Boolean(
      game &&
        (room.phase === "VOTING" || room.phase === "RUNOFF") &&
        self.participates &&
        self.alive &&
        !self.left &&
        !game.votes.has(self.id),
    );
    const privateIdentity: PrivateIdentity | null = self.role ? { role: self.role, word: self.word } : null;
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
        .filter((player) => !player.left)
        .sort((left, right) => left.joinedAt - right.joinedAt)
        .map((player) => ({
          id: player.id,
          nickname: player.nickname,
          isHost: player.id === room.hostId,
          isOnline: player.socketIds.size > 0,
          isParticipating: player.participates,
          isAlive: player.alive,
          hasSubmittedVote: player.id === self.id ? Boolean(game?.votes.has(player.id)) : false,
        })),
      speakingOrder: game?.speakingOrder ?? [],
      privateIdentity,
      voting:
        game && game.votingKind
          ? {
              kind: game.votingKind,
              submittedCount: game.votes.size,
              eligibleCount: eligibleVoters.length,
              candidateIds: [...game.allowedTargetIds],
              allowedTargetIds: canVote
                ? [...game.allowedTargetIds].filter((playerId) => playerId !== self.id)
                : [],
              runoffTallies: game.votingKind === "RUNOFF" ? game.runoffTallies : null,
              canVote,
              canAbstain: canVote && this.alivePlayers(room).length >= 4,
              deadlineAt: game.deadlineAt,
            }
          : null,
      roundResult: game?.currentRoundResult ?? null,
      finalResult: room.phase === "ENDED" ? this.finalResult(room) : null,
      permissions: {
        canStart: isHost && room.phase === "WAITING" && this.activeParticipants(room).length === this.requiredPlayerCount(room),
        canBeginVote: isHost && room.phase === "SPEAKING",
        canFinishRunoff: isHost && room.phase === "RUNOFF",
        canTransferHost: isHost && this.onlineMembers(room).some((player) => player.id !== self.id),
        canRematch: isHost && room.phase === "ENDED",
        canDissolve: isHost,
      },
    };
  }

  private finalResult(room: Room): FinalResult | null {
    const game = room.game;
    if (!game?.winner) return null;
    const players: RevealedPlayer[] = [...room.players.values()]
      .filter((player) => player.role !== null)
      .sort((left, right) => left.joinedAt - right.joinedAt)
      .map((player) => ({
        id: player.id,
        nickname: player.nickname,
        role: player.role as Role,
        isAlive: player.alive,
        hasLeft: player.left,
      }));
    return {
      winner: game.winner,
      civilianWord: game.wordPair.civilian,
      undercoverWord: game.wordPair.undercover,
      players,
      rounds: game.roundResults,
    };
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
      .filter((player) => player.id !== host.id)
      .sort((left, right) => left.joinedAt - right.joinedAt)[0];
    if (!successor) return;
    room.hostId = successor.id;
    room.hostDisconnectedAt = null;
    this.touchAndPublish(room);
  }

  private closeRoom(room: Room, reason: "DISSOLVED" | "EXPIRED"): void {
    const socketIds = [...room.players.values()].flatMap((player) => [...player.socketIds]);
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
    return Boolean(votes && this.eligibleVoters(room).every((player) => votes.has(player.id)));
  }

  private eligibleVoters(room: Room): Player[] {
    return this.alivePlayers(room);
  }

  private alivePlayers(room: Room): Player[] {
    return [...room.players.values()].filter((player) => player.participates && player.alive && !player.left);
  }

  private activeParticipants(room: Room): Player[] {
    return [...room.players.values()].filter((player) => player.participates && !player.left);
  }

  private onlineMembers(room: Room): Player[] {
    return [...room.players.values()].filter((player) => !player.left && player.socketIds.size > 0);
  }

  private requiredPlayerCount(room: Room): number {
    return room.config.civilianCount + room.config.undercoverCount + room.config.blankCount;
  }

  private generateSpeakingOrder(players: Player[]): string[] {
    return createSpeakingOrder(
      players
        .filter((player): player is Player & { role: Role } => player.role !== null)
        .map((player): RoleHolder => ({ id: player.id, role: player.role })),
      this.random,
    );
  }

  private createPlayer(nickname: string, participates: boolean, socketId: string): Player {
    return {
      id: randomUUID(),
      nickname,
      normalizedNickname: this.normalizeNickname(nickname),
      resumeToken: randomBytes(32).toString("base64url"),
      joinedAt: this.now(),
      socketIds: new Set([socketId]),
      participates,
      alive: participates,
      left: false,
      role: null,
      word: null,
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

  private normalizeNickname(value: string): string {
    return normalizedNicknameKey(value);
  }

  private validateConfig(config: RoomConfig): void {
    const error = roleConfigError(config);
    if (error) throw new GameError("INVALID_CONFIG", error);
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

  private pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.random() * items.length)];
    if (item === undefined) throw new GameError("INTERNAL_ERROR", "随机选择失败");
    return item;
  }


  private invalidatePlayerSessions(player: Player): void {
    for (const socketId of player.socketIds) this.sessions.delete(socketId);
  }

  private clearRoomTimer(
    timers: Map<string, ReturnType<typeof setTimeout>>,
    roomCode: string,
  ): void {
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
