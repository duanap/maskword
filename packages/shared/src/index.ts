export const ROOM_PHASES = [
  "WAITING",
  "SPEAKING",
  "VOTING",
  "RUNOFF",
  "ROUND_RESULT",
  "ENDED",
] as const;

export type RoomPhase = (typeof ROOM_PHASES)[number];
export type Role = "CIVILIAN" | "UNDERCOVER" | "BLANK";
export type Winner = "CIVILIAN" | "UNDERCOVER";

export interface RoomConfig {
  civilianCount: number;
  undercoverCount: number;
  blankCount: number;
  hostParticipates: boolean;
}

export interface PublicPlayer {
  id: string;
  nickname: string;
  isHost: boolean;
  isOnline: boolean;
  isParticipating: boolean;
  isAlive: boolean;
  hasSubmittedVote: boolean;
}

export interface PrivateIdentity {
  role: Role;
  word: string | null;
}

export interface VoteTally {
  playerId: string;
  votes: number;
}

export interface RoundResult {
  round: number;
  eliminatedPlayerId: string | null;
  tallies: VoteTally[];
  abstainCount: number;
  reason: "ELIMINATED" | "TIE" | "NO_VALID_VOTE" | "RUNOFF_CANCELLED";
}

export interface RevealedPlayer {
  id: string;
  nickname: string;
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
    deadlineAt: number | null;
  };
  roundResult: RoundResult | null;
  finalResult: FinalResult | null;
  permissions: {
    canStart: boolean;
    canBeginVote: boolean;
    canFinishRunoff: boolean;
    canTransferHost: boolean;
    canRematch: boolean;
    canDissolve: boolean;
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
  | "UNAUTHORIZED"
  | "INVALID_PHASE"
  | "INVALID_VOTE"
  | "ALREADY_VOTED"
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
}

export interface JoinRoomInput {
  nickname: string;
  roomCode: string;
}

export interface ResumeRoomInput extends SessionCredentials {}

export interface ClientToServerEvents {
  "room:create": (input: CreateRoomInput, ack: (result: Ack<SessionCredentials>) => void) => void;
  "room:join": (input: JoinRoomInput, ack: (result: Ack<SessionCredentials>) => void) => void;
  "room:resume": (input: ResumeRoomInput, ack: (result: Ack) => void) => void;
  "room:leave": (ack: (result: Ack) => void) => void;
  "room:dissolve": (ack: (result: Ack) => void) => void;
  "room:transferHost": (targetPlayerId: string, ack: (result: Ack) => void) => void;
  "game:start": (ack: (result: Ack) => void) => void;
  "game:beginVote": (ack: (result: Ack) => void) => void;
  "vote:submit": (targetPlayerId: string | null, ack: (result: Ack) => void) => void;
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
