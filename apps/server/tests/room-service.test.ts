import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomConfig, RoomSnapshot, SessionCredentials } from "@maskword/shared";
import { GAME_CONFIG } from "../src/config.js";
import { GameError, RoomService } from "../src/game/room-service.js";

const sixPlayers: RoomConfig = {
  civilianCount: 4,
  undercoverCount: 1,
  blankCount: 1,
  hostParticipates: true,
};

const fourPlayers: RoomConfig = {
  civilianCount: 3,
  undercoverCount: 1,
  blankCount: 0,
  hostParticipates: true,
};

function createService() {
  return new RoomService({ random: () => 0 });
}

function createPlayers(service: RoomService, config: RoomConfig, count: number) {
  const credentials: SessionCredentials[] = [];
  credentials.push(service.createRoom("房主", config, "socket-1"));
  for (let index = 2; index <= count; index += 1) {
    credentials.push(service.joinRoom(`玩家${index}`, credentials[0]!.roomCode, `socket-${index}`));
  }
  return credentials;
}

function snapshot(service: RoomService, index: number): RoomSnapshot {
  return service.snapshotForSocket(`socket-${index}`);
}

describe("RoomService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("validates room configuration and normalized duplicate nicknames", () => {
    const service = createService();
    expect(() =>
      service.createRoom("房主", { civilianCount: 1, undercoverCount: 1, blankCount: 0, hostParticipates: true }, "socket-1"),
    ).toThrowError(GameError);

    const host = service.createRoom("Alice", fourPlayers, "socket-1");
    expect(() => service.joinRoom(" alice ", host.roomCode, "socket-2")).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_NICKNAME" }),
    );
  });

  it("deals the configured roles and never exposes another player's private identity", () => {
    const service = createService();
    createPlayers(service, sixPlayers, 6);
    service.startGame("socket-1");

    const snapshots = Array.from({ length: 6 }, (_, index) => snapshot(service, index + 1));
    const roles = snapshots.map((item) => item.privateIdentity?.role);
    expect(roles.filter((role) => role === "CIVILIAN")).toHaveLength(4);
    expect(roles.filter((role) => role === "UNDERCOVER")).toHaveLength(1);
    expect(roles.filter((role) => role === "BLANK")).toHaveLength(1);
    expect(snapshots[0]!.players.every((player) => !("role" in player) && !("word" in player))).toBe(true);
    expect(snapshots[0]!.speakingOrder[0]).not.toBe(
      snapshots.find((item) => item.privateIdentity?.role === "BLANK")?.selfId,
    );
  });

  it("runs an untimed runoff and advances with no elimination after another tie", () => {
    const service = createService();
    createPlayers(service, fourPlayers, 4);
    service.startGame("socket-1");
    service.beginVote("socket-1");
    const ids = Array.from({ length: 4 }, (_, index) => snapshot(service, index + 1).selfId);

    service.submitVote("socket-1", ids[1]!);
    service.submitVote("socket-2", ids[0]!);
    service.submitVote("socket-3", ids[0]!);
    service.submitVote("socket-4", ids[1]!);

    const selfRunoff = snapshot(service, 1);
    expect(selfRunoff.phase).toBe("RUNOFF");
    expect(selfRunoff.voting?.deadlineAt).toBeNull();
    expect(selfRunoff.voting?.candidateIds).toEqual(expect.arrayContaining([ids[0], ids[1]]));
    expect(selfRunoff.voting?.allowedTargetIds).toEqual([ids[1]]);
    expect(selfRunoff.voting?.runoffTallies).toEqual(
      expect.arrayContaining([
        { playerId: ids[0], votes: 2 },
        { playerId: ids[1], votes: 2 },
      ]),
    );
    service.submitVote("socket-1", ids[1]!);
    expect(snapshot(service, 1).voting?.candidateIds).toEqual(expect.arrayContaining([ids[0], ids[1]]));
    service.submitVote("socket-2", ids[0]!);
    service.submitVote("socket-3", null);
    service.submitVote("socket-4", null);

    expect(snapshot(service, 1).phase).toBe("ROUND_RESULT");
    expect(snapshot(service, 1).roundResult).toMatchObject({ eliminatedPlayerId: null, reason: "TIE" });
    expect(snapshot(service, 1).roundResultEndsAt).toBe(Date.now() + GAME_CONFIG.roundResultDurationMs);
    vi.advanceTimersByTime(GAME_CONFIG.roundResultDurationMs);
    expect(snapshot(service, 1).phase).toBe("SPEAKING");
    expect(snapshot(service, 1).round).toBe(2);
    expect(snapshot(service, 1).roundResultEndsAt).toBeNull();
  });

  it("settles a normal vote at the deadline and treats missing voters as abstentions", () => {
    const service = createService();
    createPlayers(service, fourPlayers, 4);
    service.startGame("socket-1");
    service.beginVote("socket-1");
    service.submitVote("socket-1", snapshot(service, 2).selfId);
    vi.advanceTimersByTime(GAME_CONFIG.normalVoteDurationMs);
    expect(snapshot(service, 1).phase).toBe("ROUND_RESULT");
    expect(snapshot(service, 1).roundResult).toMatchObject({ abstainCount: 3, reason: "ELIMINATED" });
  });

  it("invalidates votes targeting a player who actively exits", () => {
    const service = createService();
    createPlayers(service, fourPlayers, 4);
    service.startGame("socket-1");
    service.beginVote("socket-1");
    const leavingId = snapshot(service, 2).selfId;
    service.submitVote("socket-1", leavingId);
    service.submitVote("socket-3", leavingId);
    service.leaveRoom("socket-2");
    expect(snapshot(service, 1).phase).toBe("VOTING");
    expect(snapshot(service, 1).voting).toMatchObject({ submittedCount: 0, eligibleCount: 3 });
    expect(snapshot(service, 1).voting?.allowedTargetIds).not.toContain(leavingId);
  });

  it("disallows abstaining with three survivors", () => {
    const service = createService();
    const config: RoomConfig = { civilianCount: 2, undercoverCount: 1, blankCount: 0, hostParticipates: true };
    createPlayers(service, config, 3);
    service.startGame("socket-1");
    service.beginVote("socket-1");
    expect(snapshot(service, 1).voting?.canAbstain).toBe(false);
    expect(() => service.submitVote("socket-1", null)).toThrowError(expect.objectContaining({ code: "INVALID_VOTE" }));
  });

  it("keeps host controls after elimination and resets the room for a rematch", () => {
    const service = createService();
    createPlayers(service, sixPlayers, 6);
    service.startGame("socket-1");
    service.beginVote("socket-1");
    const hostId = snapshot(service, 1).selfId;
    for (let index = 2; index <= 6; index += 1) service.submitVote(`socket-${index}`, hostId);
    service.submitVote("socket-1", snapshot(service, 2).selfId);

    vi.advanceTimersByTime(GAME_CONFIG.roundResultDurationMs);
    const nextRound = snapshot(service, 1);
    expect(nextRound.phase).toBe("SPEAKING");
    expect(nextRound.players.find((player) => player.id === hostId)?.isAlive).toBe(false);
    expect(nextRound.permissions.canBeginVote).toBe(true);

    // End the game by removing the sole undercover, then return to the lobby.
    const undercoverSocket = Array.from({ length: 6 }, (_, index) => index + 1).find(
      (index) => snapshot(service, index).privateIdentity?.role === "UNDERCOVER",
    );
    expect(undercoverSocket).toBeDefined();
    if (undercoverSocket === 1) throw new Error("deterministic fixture expected a non-host undercover");
    service.beginVote("socket-1");
    const undercoverId = snapshot(service, undercoverSocket!).selfId;
    for (let index = 1; index <= 6; index += 1) {
      const player = snapshot(service, index).players.find((item) => item.id === snapshot(service, index).selfId);
      if (player?.isAlive) service.submitVote(`socket-${index}`, index === undercoverSocket ? snapshot(service, 2).selfId : undercoverId);
    }
    expect(snapshot(service, 1).phase).toBe("ENDED");
    service.rematch("socket-1");
    expect(snapshot(service, 1)).toMatchObject({ phase: "WAITING", round: 0, privateIdentity: null });
  });

  it("automatically transfers an offline host after fifteen seconds", () => {
    const service = createService();
    createPlayers(service, fourPlayers, 2);
    const successorId = snapshot(service, 2).selfId;
    service.disconnect("socket-1");
    vi.advanceTimersByTime(GAME_CONFIG.hostTransferDelayMs - 1);
    expect(snapshot(service, 2).hostId).not.toBe(successorId);
    vi.advanceTimersByTime(1);
    expect(snapshot(service, 2).hostId).toBe(successorId);
  });

  it("invalidates a deliberate exit while allowing token-based reconnection", () => {
    const service = createService();
    const credentials = createPlayers(service, fourPlayers, 2);
    service.disconnect("socket-2");
    service.resumeRoom(credentials[1]!, "socket-2b");
    expect(service.snapshotForSocket("socket-2b").selfId).toBe(credentials[1]!.playerId);
    service.leaveRoom("socket-2b");
    expect(() => service.resumeRoom(credentials[1]!, "socket-2c")).toThrowError(
      expect.objectContaining({ code: "RECOVERY_FAILED" }),
    );
  });

  it("starts the in-game cleanup clock only when the last player disconnects", () => {
    let currentTime = 10_000;
    const service = new RoomService({ random: () => 0, now: () => currentTime });
    createPlayers(service, fourPlayers, 4);
    service.startGame("socket-1");
    currentTime += GAME_CONFIG.allOfflineGameTtlMs + 1;
    service.cleanupExpiredRooms();
    expect(service.getRoomCount()).toBe(1);
    for (let index = 1; index <= 4; index += 1) service.disconnect(`socket-${index}`);
    service.cleanupExpiredRooms();
    expect(service.getRoomCount()).toBe(1);
    currentTime += GAME_CONFIG.allOfflineGameTtlMs;
    service.cleanupExpiredRooms();
    expect(service.getRoomCount()).toBe(0);
  });
});
