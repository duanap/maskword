export const ROOM_PHASES = [
  "WAITING",
  "SPEAKING",
  "VOTING",
  "RUNOFF",
  "ROUND_RESULT",
  "ENDED",
] as const;

export const GAME_MODES = ["CLASSIC_REVEALED", "CLASSIC_HIDDEN", "EXPLOSIVE_REVEALED", "EXPLOSIVE_HIDDEN"] as const;
export const WORD_CATEGORIES = [
  "GENERAL",
  "FUNNY",
  "IDIOM",
  "FOOD",
  "ANIMAL_NATURE",
  "DAILY",
  "SCHOOL_WORK",
  "TRAVEL",
  "ENTERTAINMENT",
  "TECH",
  "MEDICAL",
  "GAME",
  "HONOR_OF_KINGS",
  "CAR",
  "SCIENCE",
] as const;
export const WORD_DIFFICULTIES = ["EASY", "STANDARD", "HARD"] as const;
export const AVATAR_IDS = [
  "fox", "panda", "frog", "robot", "whale", "owl", "cat", "dog",
  "rabbit", "lion", "koala", "penguin", "bear", "deer", "octopus", "raccoon",
] as const;

export type RoomPhase = (typeof ROOM_PHASES)[number];
export type GameMode = (typeof GAME_MODES)[number];
export type WordCategory = (typeof WORD_CATEGORIES)[number];
export type WordDifficulty = (typeof WORD_DIFFICULTIES)[number];
export type WordAudience = "GENERAL" | "INTEREST";
export type AvatarId = (typeof AVATAR_IDS)[number];
export type Role = "CIVILIAN" | "UNDERCOVER" | "BLANK" | "DOUBLE_AGENT";
export type Winner = "CIVILIAN" | "UNDERCOVER";
export type ResultAdvance = "AUTO" | "MANUAL";
export type SpeakingSeconds = 0 | 30 | 45 | 60;

export interface RoomConfig {
  civilianCount: number;
  undercoverCount: number;
  blankCount: number;
  doubleAgentCount: number;
  hostParticipates: boolean;
  mode: GameMode;
  wordCategory: WordCategory;
  wordDifficulty: WordDifficulty;
  selfDestructRound: 2 | 3 | 4;
  speakingSeconds: SpeakingSeconds;
  resultAdvance: ResultAdvance;
}

export interface CustomWords {
  civilian: string;
  undercover: string;
}

export interface PublicPlayer {
  id: string;
  nickname: string;
  avatarId: AvatarId;
  isHost: boolean;
  isOnline: boolean;
  isParticipating: boolean;
  isAlive: boolean;
  hasSubmittedVote: boolean;
}

export interface PrivateIdentity {
  role: Role | null;
  word: string | null;
  roleRevealed: boolean;
  selfDestruct: {
    eligible: boolean;
    used: boolean;
    sealed: boolean;
  };
}

export interface VoteTally {
  playerId: string;
  votes: number;
}

export interface SelfDestructResult {
  playerId: string;
  role: "UNDERCOVER" | "DOUBLE_AGENT";
  guess: string;
  correct: boolean;
}

export interface RoundResult {
  round: number;
  eliminatedPlayerIds: string[];
  voteEliminatedPlayerId: string | null;
  selfDestructResults: SelfDestructResult[];
  tallies: VoteTally[];
  abstainCount: number;
  reason: "ELIMINATED" | "MULTIPLE_ELIMINATED" | "TIE" | "NO_VALID_VOTE" | "RUNOFF_CANCELLED";
}

export interface RevealedPlayer {
  id: string;
  nickname: string;
  avatarId: AvatarId;
  role: Role;
  isAlive: boolean;
  hasLeft: boolean;
}

export interface FinalResult {
  winner: Winner;
  civilianWord: string;
  undercoverWord: string;
  players: RevealedPlayer[];
  rounds: RoundResult[];
}

export interface RoomSnapshot {
  roomCode: string;
  phase: RoomPhase;
  config: RoomConfig;
  hostId: string;
  selfId: string;
  round: number;
  requiredPlayerCount: number;
  participatingPlayerCount: number;
  players: PublicPlayer[];
  speakingOrder: string[];
  speaking: null | {
    currentPlayerId: string | null;
    startedAt: number | null;
    deadlineAt: number | null;
    completedPlayerIds: string[];
  };
  privateIdentity: PrivateIdentity | null;
  voting: null | {
    kind: "NORMAL" | "RUNOFF";
    submittedCount: number;
    eligibleCount: number;
    candidateIds: string[];
    allowedTargetIds: string[];
    runoffTallies: VoteTally[] | null;
    canVote: boolean;
    canAbstain: boolean;
    canGuess: boolean;
    deadlineAt: number | null;
  };
  roundResult: RoundResult | null;
  roundResultEndsAt: number | null;
  finalResult: FinalResult | null;
  permissions: {
    canStart: boolean;
    canBeginVote: boolean;
    canStartSpeaking: boolean;
    canEndSpeaking: boolean;
    canAdvanceRound: boolean;
    canFinishRunoff: boolean;
    canTransferHost: boolean;
    canRematch: boolean;
    canDissolve: boolean;
    canChangeAvatar: boolean;
  };
}

export type ErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CONFIG"
  | "ROOM_NOT_FOUND"
  | "ROOM_CLOSED"
  | "ROOM_FULL"
  | "GAME_IN_PROGRESS"
  | "DUPLICATE_NICKNAME"
  | "AVATAR_TAKEN"
  | "UNAUTHORIZED"
  | "INVALID_PHASE"
  | "INVALID_VOTE"
  | "ALREADY_VOTED"
  | "SELF_DESTRUCT_UNAVAILABLE"
  | "SELF_DESTRUCT_USED"
  | "WORD_POOL_EMPTY"
  | "RECOVERY_FAILED"
  | "INTERNAL_ERROR";

export type Ack<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; code: ErrorCode; message: string };

export interface SessionCredentials {
  roomCode: string;
  playerId: string;
  resumeToken: string;
}

export interface CreateRoomInput {
  nickname: string;
  config: RoomConfig;
  customWords?: CustomWords;
}

export interface JoinRoomInput {
  nickname: string;
  roomCode: string;
}

export interface VoteSubmission {
  targetPlayerId: string | null;
  guess?: string;
}

export interface ResumeRoomInput extends SessionCredentials {}

export interface ClientToServerEvents {
  "room:create": (input: CreateRoomInput, ack: (result: Ack<SessionCredentials>) => void) => void;
  "room:join": (input: JoinRoomInput, ack: (result: Ack<SessionCredentials>) => void) => void;
  "room:resume": (input: ResumeRoomInput, ack: (result: Ack) => void) => void;
  "room:leave": (ack: (result: Ack) => void) => void;
  "room:dissolve": (ack: (result: Ack) => void) => void;
  "room:transferHost": (targetPlayerId: string, ack: (result: Ack) => void) => void;
  "room:changeAvatar": (avatarId: AvatarId, ack: (result: Ack) => void) => void;
  "game:start": (ack: (result: Ack) => void) => void;
  "game:startSpeaking": (ack: (result: Ack) => void) => void;
  "game:endSpeaking": (ack: (result: Ack) => void) => void;
  "game:beginVote": (ack: (result: Ack) => void) => void;
  "game:advanceRound": (ack: (result: Ack) => void) => void;
  "vote:submit": (submission: VoteSubmission, ack: (result: Ack) => void) => void;
  "vote:finishRunoff": (ack: (result: Ack) => void) => void;
  "game:rematch": (ack: (result: Ack) => void) => void;
}

export interface ServerToClientEvents {
  "room:snapshot": (snapshot: RoomSnapshot) => void;
  "room:closed": (payload: { reason: "DISSOLVED" | "EXPIRED" }) => void;
  notice: (payload: { message: string; tone: "INFO" | "SUCCESS" | "WARNING" | "ERROR" }) => void;
}

export * from "./game.ts";
export * from "./words.ts";
