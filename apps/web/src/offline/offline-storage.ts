import type { OfflineGameState } from "./types";

export const OFFLINE_STORAGE_KEY = "maskword-offline-v2";
export const LEGACY_OFFLINE_STORAGE_KEY = "maskword-offline-v1";

function isOfflineState(value: unknown): value is OfflineGameState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<OfflineGameState>;
  return state.schemaVersion === 2 && typeof state.phase === "string" && Array.isArray(state.members)
    && typeof state.hostId === "string" && typeof state.round === "number" && Boolean(state.config) && Boolean(state.wordPair);
}

export function normalizedForStorage(state: OfflineGameState): OfflineGameState {
  const copy = JSON.parse(JSON.stringify(state)) as OfflineGameState;
  if (copy.privacy.mode === "REVEAL" || copy.privacy.mode === "CAST") copy.privacy.mode = "HANDOFF";
  copy.updatedAt = Date.now();
  return copy;
}

export function saveOfflineState(state: OfflineGameState): void {
  localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(normalizedForStorage(state)));
}

export interface OfflineStateLoadResult {
  state: OfflineGameState | null;
  corrupted: boolean;
  legacyCleared: boolean;
}

export function loadOfflineState(): OfflineStateLoadResult {
  const legacyCleared = localStorage.getItem(LEGACY_OFFLINE_STORAGE_KEY) !== null;
  if (legacyCleared) localStorage.removeItem(LEGACY_OFFLINE_STORAGE_KEY);
  const raw = localStorage.getItem(OFFLINE_STORAGE_KEY);
  if (!raw) return { state: null, corrupted: false, legacyCleared };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isOfflineState(parsed)) throw new Error("invalid state");
    return { state: normalizedForStorage(parsed), corrupted: false, legacyCleared };
  } catch {
    localStorage.removeItem(OFFLINE_STORAGE_KEY);
    return { state: null, corrupted: true, legacyCleared };
  }
}

export function clearOfflineState(): void {
  localStorage.removeItem(OFFLINE_STORAGE_KEY);
  localStorage.removeItem(LEGACY_OFFLINE_STORAGE_KEY);
}
