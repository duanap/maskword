export function extractRoomCode(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.match(/(?:^|\D)(\d{6})(?!\d)/)?.[1] ?? null;
}

export function normalizeRoomCodeInput(value: string): string {
  return extractRoomCode(value) ?? value.replace(/\D/g, "").slice(0, 6);
}

export function buildRoomInviteUrl(origin: string, roomCode: string): string {
  const url = new URL("/", origin);
  url.searchParams.set("room", roomCode);
  return url.toString();
}
