import type {
  GameMode,
  Role,
  RoomConfig,
  VoteTally,
  Winner,
  WordAudience,
  WordCategory,
  WordDifficulty,
} from "./index.ts";

export interface WordPair {
  civilian: string;
  undercover: string;
  category: WordCategory;
  difficulty: WordDifficulty;
  audience: WordAudience;
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

const defaultBase = {
  doubleAgentCount: 0,
  hostParticipates: true,
  mode: "CLASSIC_REVEALED" as const,
  wordCategory: "GENERAL" as const,
  wordDifficulty: "STANDARD" as const,
  selfDestructRound: 2 as const,
  speakingSeconds: 0 as const,
  resultAdvance: "AUTO" as const,
};

export const DEFAULT_ROLE_CONFIGS: Readonly<Record<number, RoomConfig>> = {
  3: { ...defaultBase, civilianCount: 2, undercoverCount: 1, blankCount: 0 },
  4: { ...defaultBase, civilianCount: 3, undercoverCount: 1, blankCount: 0 },
  5: { ...defaultBase, civilianCount: 4, undercoverCount: 1, blankCount: 0 },
  6: { ...defaultBase, civilianCount: 5, undercoverCount: 1, blankCount: 0 },
  7: { ...defaultBase, civilianCount: 5, undercoverCount: 2, blankCount: 0 },
  8: { ...defaultBase, civilianCount: 6, undercoverCount: 2, blankCount: 0 },
  9: { ...defaultBase, civilianCount: 7, undercoverCount: 2, blankCount: 0 },
  10: { ...defaultBase, civilianCount: 7, undercoverCount: 3, blankCount: 0 },
  11: { ...defaultBase, civilianCount: 8, undercoverCount: 3, blankCount: 0 },
  12: { ...defaultBase, civilianCount: 9, undercoverCount: 3, blankCount: 0 },
};

export function isHiddenMode(mode: GameMode): boolean {
  return mode === "CLASSIC_HIDDEN" || mode === "EXPLOSIVE_HIDDEN";
}

export function isExplosiveMode(mode: GameMode): boolean {
  return mode === "EXPLOSIVE_REVEALED" || mode === "EXPLOSIVE_HIDDEN";
}

export function normalizeNickname(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizedNicknameKey(value: string): string {
  return normalizeNickname(value).normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function normalizeGuess(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

export function roleConfigError(config: RoomConfig): string | null {
  const values = [config.civilianCount, config.undercoverCount, config.blankCount, config.doubleAgentCount];
  if (values.some((value) => !Number.isInteger(value))) return "身份人数必须为整数";
  const total = values.reduce((sum, value) => sum + value, 0);
  const specialCount = config.blankCount + config.doubleAgentCount;
  const undercoverTeam = config.undercoverCount + config.doubleAgentCount;
  const otherTeam = config.civilianCount + config.blankCount;
  if (config.civilianCount < 1 || config.undercoverCount < 1 || config.blankCount < 0 || config.doubleAgentCount < 0 || total < 3 || total > 12) {
    return "请设置 3–12 人的有效身份配置，并至少保留一名平民和一名普通卧底";
  }
  if (undercoverTeam >= otherTeam) return "开局时卧底阵营人数必须少于其他玩家";
  if (specialCount > Math.floor(total / 3)) return "白板和双面间谍总数不能超过参赛人数的三分之一";
  if (config.blankCount > 0 && (total < 5 || isHiddenMode(config.mode))) return "白板仅可在 5 人以上的明牌模式中启用";
  if (config.doubleAgentCount > 0 && (total < 5 || !isExplosiveMode(config.mode))) return "双面间谍仅可在 5 人以上的自爆模式中启用";
  if (config.blankCount > 0 && config.doubleAgentCount > 0 && total < 7) return "白板和双面间谍同时启用至少需要 7 人";
  if (![2, 3, 4].includes(config.selfDestructRound)) return "自爆提示轮只能是第 2、3 或 4 轮";
  if (![0, 30, 45, 60].includes(config.speakingSeconds)) return "发言时长设置无效";
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
      ...Array.from({ length: config.doubleAgentCount }, () => "DOUBLE_AGENT" as const),
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
  const undercoverTeam = alive.filter((player) => player.role === "UNDERCOVER" || player.role === "DOUBLE_AGENT").length;
  const others = alive.length - undercoverTeam;
  if (undercoverTeam === 0) return "CIVILIAN";
  if (undercoverTeam >= others) return "UNDERCOVER";
  return null;
}
