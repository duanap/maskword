import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOfflineState, normalizedForStorage, OFFLINE_STORAGE_KEY } from "./offline-storage";
import { createOfflineGame, validateOfflineSetup } from "./useOfflineGame";
import type { OfflineGameState, OfflineSetup } from "./types";

function installStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
  return values;
}

function setup(count = 3, hostParticipates = true): OfflineSetup {
  const presets = {
    3: { civilianCount: 2, undercoverCount: 1, blankCount: 0 },
    4: { civilianCount: 3, undercoverCount: 1, blankCount: 0 },
    6: { civilianCount: 4, undercoverCount: 1, blankCount: 1 },
  } as const;
  const memberCount = count + (hostParticipates ? 0 : 1);
  return {
    participantCount: count,
    hostParticipates,
    names: Array.from({ length: memberCount }, (_, index) => index === 0 ? "主持人" : `玩家${index + 1}`),
    config: { ...(presets[count as keyof typeof presets] ?? presets[3]), hostParticipates },
  };
}

function finishDeal(game: ReturnType<typeof createOfflineGame>) {
  const count = game.state.value!.participantCount;
  for (let index = 0; index < count; index += 1) {
    game.beginPrivateTurn();
    expect(game.state.value!.privacy.mode).toBe("REVEAL");
    game.hideIdentity();
  }
  expect(game.state.value!.phase).toBe("SPEAKING");
}

function reachVote(game: ReturnType<typeof createOfflineGame>) {
  finishDeal(game);
  const speakers = game.state.value!.speakingOrder.length;
  for (let index = 0; index < speakers; index += 1) game.nextSpeaker();
  expect(game.state.value!.phase).toBe("VOTING");
}

function cast(game: ReturnType<typeof createOfflineGame>, targetId: string | null) {
  game.beginPrivateTurn();
  expect(game.state.value!.privacy.mode).toBe("CAST");
  expect(game.submitVote(targetId)).toBeNull();
}

beforeEach(() => installStorage());

describe("offline game", () => {
  it("validates names and a non-playing host setup", () => {
    expect(validateOfflineSetup(setup(3, false))).toBeNull();
    const invalid = setup();
    invalid.names[2] = " 主持人 ";
    expect(validateOfflineSetup(invalid)).toContain("不能重复");
  });

  it("completes a private three-player game and rematches with the same people", () => {
    const game = createOfflineGame(() => 0);
    expect(game.start(setup())).toBeNull();
    reachVote(game);
    cast(game, "local-2");
    cast(game, "local-1");
    cast(game, "local-2");
    expect(game.state.value!.phase).toBe("ENDED");
    expect(game.state.value!.winner).toBe("CIVILIAN");
    const names = game.state.value!.members.map((member) => member.nickname);
    game.rematch();
    expect(game.state.value!.phase).toBe("DEALING");
    expect(game.state.value!.members.map((member) => member.nickname)).toEqual(names);
  });

  it("disallows a three-player abstention and allows it with four alive players", () => {
    const three = createOfflineGame(() => 0);
    three.start(setup());
    reachVote(three);
    three.beginPrivateTurn();
    expect(three.submitVote(null)).toContain("三人");

    const four = createOfflineGame(() => 0);
    four.start(setup(4));
    reachVote(four);
    cast(four, null);
    expect(four.state.value!.voterIndex).toBe(1);
  });

  it("enters an unlimited runoff and lets the host finish missing votes as abstentions", () => {
    const game = createOfflineGame(() => 0);
    game.start(setup(4));
    reachVote(game);
    cast(game, "local-2");
    cast(game, "local-1");
    cast(game, "local-1");
    cast(game, "local-2");
    expect(game.state.value!.phase).toBe("RUNOFF");
    expect(game.state.value!.candidateIds).toEqual(["local-1", "local-2"]);
    game.finishRunoff();
    expect(game.state.value!.phase).toBe("ROUND_RESULT");
    expect(game.state.value!.roundResult?.eliminatedPlayerId).toBeNull();
    expect(game.state.value!.roundResult?.abstainCount).toBe(4);
  });

  it("resets every ordinary ballot when an alive player exits", () => {
    const game = createOfflineGame(() => 0);
    game.start(setup(4));
    reachVote(game);
    cast(game, "local-2");
    expect(Object.keys(game.state.value!.votes)).toHaveLength(1);
    expect(game.markLeft("local-4")).toBeNull();
    expect(game.state.value!.phase).toBe("VOTING");
    expect(game.state.value!.votes).toEqual({});
    expect(game.state.value!.voterOrder).toHaveLength(3);
  });

  it("keeps an eliminated host in control and permits an explicit transfer", () => {
    const game = createOfflineGame(() => 0);
    game.start(setup(4));
    finishDeal(game);
    game.state.value!.members[0]!.alive = false;
    expect(game.state.value!.hostId).toBe("local-1");
    expect(game.transferHost("local-2")).toBeNull();
    expect(game.state.value!.hostId).toBe("local-2");
  });
});

describe("offline storage", () => {
  it("normalizes visible secrets and vote entry to a neutral handoff", () => {
    const game = createOfflineGame(() => 0);
    game.start(setup());
    game.beginPrivateTurn();
    const reveal = normalizedForStorage(game.state.value!);
    expect(reveal.privacy.mode).toBe("HANDOFF");
    finishDeal(game);
    for (let index = 0; index < game.state.value!.speakingOrder.length; index += 1) game.nextSpeaker();
    game.beginPrivateTurn();
    const castState = normalizedForStorage(game.state.value!);
    expect(castState.privacy.mode).toBe("HANDOFF");
  });

  it("persists committed state under the versioned key", () => {
    const values = installStorage();
    const game = createOfflineGame(() => 0);
    game.start(setup());
    const saved = JSON.parse(values.get(OFFLINE_STORAGE_KEY)!) as OfflineGameState;
    expect(saved.schemaVersion).toBe(1);
    expect(saved.privacy.mode).toBe("HANDOFF");
  });

  it("rejects a corrupt save and reports that it was safely cleared", () => {
    localStorage.setItem(OFFLINE_STORAGE_KEY, "{broken");
    expect(loadOfflineState()).toEqual({ state: null, corrupted: true });
    expect(localStorage.getItem(OFFLINE_STORAGE_KEY)).toBeNull();
  });
});
