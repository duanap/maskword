import type { Role, RoomConfig, RoundResult, VoteTally, Winner, WordPair } from "@maskword/shared";

export type OfflinePhase = "DEALING" | "SPEAKING" | "VOTING" | "RUNOFF" | "ROUND_RESULT" | "ENDED";
export type PrivateMode = "PUBLIC" | "HANDOFF" | "REVEAL" | "CAST";
export type PrivatePurpose = "DEALING" | "RECHECK" | "VOTING" | "RUNOFF" | null;

export interface OfflineMember {
  id: string;
  nickname: string;
  participates: boolean;
  alive: boolean;
  left: boolean;
  role: Role | null;
  word: string | null;
}

export interface OfflinePrivacy {
  mode: PrivateMode;
  playerId: string | null;
  purpose: PrivatePurpose;
}

export interface OfflineGameState {
  schemaVersion: 1;
  phase: OfflinePhase;
  config: RoomConfig;
  participantCount: number;
  hostId: string;
  members: OfflineMember[];
  wordPair: WordPair;
  round: number;
  dealingIndex: number;
  speakingOrder: string[];
  speakerIndex: number;
  voterOrder: string[];
  voterIndex: number;
  votes: Record<string, string | null>;
  candidateIds: string[];
  runoffTallies: VoteTally[] | null;
  privacy: OfflinePrivacy;
  roundResult: RoundResult | null;
  rounds: RoundResult[];
  winner: Winner | null;
  notice: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface OfflineSetup {
  participantCount: number;
  hostParticipates: boolean;
  names: string[];
  config: RoomConfig;
}
