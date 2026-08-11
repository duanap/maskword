import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_CONFIGS,
  createRoleDeck,
  createSpeakingOrder,
  determineWinner,
  roleConfigError,
  settleVotes,
} from "@maskword/shared";

describe("shared game rules", () => {
  it("provides a valid balanced preset for every supported player count", () => {
    for (let count = 3; count <= 12; count += 1) {
      const preset = DEFAULT_ROLE_CONFIGS[count];
      expect(preset).toBeDefined();
      const config = { ...preset!, hostParticipates: true };
      expect(config.civilianCount + config.undercoverCount + config.blankCount).toBe(count);
      expect(roleConfigError(config)).toBeNull();
    }
  });

  it("deals the requested roles and protects a non-blank first speaker", () => {
    const config = { civilianCount: 3, undercoverCount: 1, blankCount: 1, hostParticipates: true };
    const roles = createRoleDeck(config, () => 0);
    expect(roles.filter((role) => role === "CIVILIAN")).toHaveLength(3);
    expect(roles.filter((role) => role === "UNDERCOVER")).toHaveLength(1);
    expect(roles.filter((role) => role === "BLANK")).toHaveLength(1);
    const players = roles.map((role, index) => ({ id: String(index), role }));
    const order = createSpeakingOrder(players, () => 0);
    expect(players.find((player) => player.id === order[0])?.role).not.toBe("BLANK");
  });

  it("counts missing and explicit abstentions without exposing vote relationships", () => {
    const result = settleVotes(["a", "b", "c"], ["a", "b", "c", "d"], { a: "b", b: null, c: "b" });
    expect(result.tallies).toEqual([
      { playerId: "b", votes: 2 },
      { playerId: "a", votes: 0 },
      { playerId: "c", votes: 0 },
    ]);
    expect(result.abstainCount).toBe(2);
    expect(result.leaderIds).toEqual(["b"]);
  });

  it("uses the same civilian and undercover winner boundary", () => {
    expect(determineWinner([{ id: "c", role: "CIVILIAN", alive: true }, { id: "u", role: "UNDERCOVER", alive: false }])).toBe("CIVILIAN");
    expect(determineWinner([{ id: "c", role: "CIVILIAN", alive: true }, { id: "u", role: "UNDERCOVER", alive: true }])).toBe("UNDERCOVER");
  });
});
