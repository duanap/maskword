export const GAME_CONFIG = {
  minPlayers: 3,
  maxPlayers: 12,
  maxBlankPlayers: 2,
  nicknameMaxLength: 12,
  normalVoteDurationMs: 60_000,
  roundResultDurationMs: 5_000,
  hostTransferDelayMs: 15_000,
  waitingRoomTtlMs: 2 * 60 * 60 * 1000,
  endedRoomTtlMs: 60 * 60 * 1000,
  allOfflineGameTtlMs: 30 * 60 * 1000,
  cleanupIntervalMs: 30_000,
} as const;

export const SERVER_CONFIG = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number.parseInt(process.env.PORT ?? "2000", 10),
  webDistPath: process.env.WEB_DIST_PATH,
} as const;
