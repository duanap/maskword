import type { Role, RoomConfig, VoteTally, Winner } from "./index.ts";

export interface WordPair {
  civilian: string;
  undercover: string;
}

export interface RoleHolder {
  id: string;
  role: Role;
}

export interface AliveRoleHolder extends RoleHolder {
  alive: boolean;
  left?: boolean;
}

export interface VoteSettlement {
  tallies: VoteTally[];
  abstainCount: number;
  leaderIds: string[];
}

export const DEFAULT_ROLE_CONFIGS: Readonly<Record<number, Omit<RoomConfig, "hostParticipates">>> = {
  3: { civilianCount: 2, undercoverCount: 1, blankCount: 0 },
  4: { civilianCount: 3, undercoverCount: 1, blankCount: 0 },
  5: { civilianCount: 3, undercoverCount: 1, blankCount: 1 },
  6: { civilianCount: 4, undercoverCount: 1, blankCount: 1 },
  7: { civilianCount: 4, undercoverCount: 2, blankCount: 1 },
  8: { civilianCount: 5, undercoverCount: 2, blankCount: 1 },
  9: { civilianCount: 6, undercoverCount: 2, blankCount: 1 },
  10: { civilianCount: 6, undercoverCount: 3, blankCount: 1 },
  11: { civilianCount: 7, undercoverCount: 3, blankCount: 1 },
  12: { civilianCount: 8, undercoverCount: 3, blankCount: 1 },
};

export function normalizeNickname(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizedNicknameKey(value: string): string {
  return normalizeNickname(value).normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function roleConfigError(config: RoomConfig): string | null {
  const values = [config.civilianCount, config.undercoverCount, config.blankCount];
  if (values.some((value) => !Number.isInteger(value))) return "身份人数必须为整数";
  const total = config.civilianCount + config.undercoverCount + config.blankCount;
  if (
    config.civilianCount < 1 ||
    config.undercoverCount < 1 ||
    config.blankCount < 0 ||
    config.blankCount > 2 ||
    total < 3 ||
    total > 12 ||
    config.undercoverCount >= config.civilianCount + config.blankCount
  ) {
    return "请设置 3–12 人的有效身份配置，且卧底不能达到其他玩家人数";
  }
  return null;
}

export function shuffleCopy<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex] as T, copy[index] as T];
  }
  return copy;
}

export function createRoleDeck(config: RoomConfig, random: () => number = Math.random): Role[] {
  const error = roleConfigError(config);
  if (error) throw new Error(error);
  return shuffleCopy(
    [
      ...Array.from({ length: config.civilianCount }, () => "CIVILIAN" as const),
      ...Array.from({ length: config.undercoverCount }, () => "UNDERCOVER" as const),
      ...Array.from({ length: config.blankCount }, () => "BLANK" as const),
    ],
    random,
  );
}

export function createSpeakingOrder(players: readonly RoleHolder[], random: () => number = Math.random): string[] {
  if (players.length === 0) return [];
  const nonBlank = players.filter((player) => player.role !== "BLANK");
  const pool = nonBlank.length > 0 ? nonBlank : [...players];
  const first = pool[Math.floor(random() * pool.length)];
  if (!first) return [];
  return [first.id, ...shuffleCopy(players.filter((player) => player.id !== first.id), random).map((player) => player.id)];
}

export function settleVotes(
  candidateIds: readonly string[],
  eligibleVoterIds: readonly string[],
  votes: Readonly<Record<string, string | null>>,
): VoteSettlement {
  const candidates = new Set(candidateIds);
  const counts = new Map<string, number>();
  let abstainCount = 0;
  for (const voterId of eligibleVoterIds) {
    if (!Object.prototype.hasOwnProperty.call(votes, voterId)) {
      abstainCount += 1;
      continue;
    }
    const targetId = votes[voterId];
    if (targetId === null || targetId === undefined || !candidates.has(targetId)) abstainCount += 1;
    else counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  const tallies = candidateIds
    .map((playerId) => ({ playerId, votes: counts.get(playerId) ?? 0 }))
    .sort((left, right) => right.votes - left.votes || left.playerId.localeCompare(right.playerId));
  const maxVotes = Math.max(0, ...tallies.map((item) => item.votes));
  const leaderIds = maxVotes > 0 ? tallies.filter((item) => item.votes === maxVotes).map((item) => item.playerId) : [];
  return { tallies, abstainCount, leaderIds };
}

export function determineWinner(players: readonly AliveRoleHolder[]): Winner | null {
  const alive = players.filter((player) => player.alive && !player.left);
  const undercovers = alive.filter((player) => player.role === "UNDERCOVER").length;
  const others = alive.length - undercovers;
  if (undercovers === 0) return "CIVILIAN";
  if (undercovers >= others) return "UNDERCOVER";
  return null;
}
