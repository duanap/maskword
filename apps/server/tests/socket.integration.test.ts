import { afterEach, describe, expect, it } from "vitest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import type {
  Ack,
  ClientToServerEvents,
  RoomConfig,
  RoomSnapshot,
  ServerToClientEvents,
  SessionCredentials,
} from "@maskword/shared";
import { createApp } from "../src/app.js";
import { RoomService } from "../src/game/room-service.js";

type TestSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;
const clients: TestSocket[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

function waitForConnect(socket: TestSocket) {
  if (socket.connected) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
}

function waitForSnapshot(socket: TestSocket, predicate: (snapshot: RoomSnapshot) => boolean) {
  return new Promise<RoomSnapshot>((resolve) => {
    const listener = (snapshot: RoomSnapshot) => {
      if (!predicate(snapshot)) return;
      socket.off("room:snapshot", listener);
      resolve(snapshot);
    };
    socket.on("room:snapshot", listener);
  });
}

describe("Socket.IO room flow", () => {
  it("rejects non-host actions, resumes a player, and keeps snapshots private", async () => {
    const service = new RoomService({ random: () => 0 });
    const { app } = await createApp(service);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const url = `http://127.0.0.1:${address.port}`;
    const host = createClient(url, { transports: ["websocket"] });
    const guest = createClient(url, { transports: ["websocket"] });
    clients.push(host, guest);
    await Promise.all([waitForConnect(host), waitForConnect(guest)]);

    const config: RoomConfig = { civilianCount: 2, undercoverCount: 1, blankCount: 0, hostParticipates: true };
    const hostCredentials = await new Promise<SessionCredentials>((resolve, reject) => {
      host.emit("room:create", { nickname: "房主", config }, (result: Ack<SessionCredentials>) => {
        if (result.ok && "data" in result) resolve(result.data);
        else reject(new Error(result.ok ? "Missing data" : result.message));
      });
    });
    const guestCredentials = await new Promise<SessionCredentials>((resolve, reject) => {
      guest.emit("room:join", { nickname: "玩家2", roomCode: hostCredentials.roomCode }, (result: Ack<SessionCredentials>) => {
        if (result.ok && "data" in result) resolve(result.data);
        else reject(new Error(result.ok ? "Missing data" : result.message));
      });
    });

    const unauthorized = await new Promise<Ack>((resolve) => guest.emit("game:start", resolve));
    expect(unauthorized).toMatchObject({ ok: false, code: "UNAUTHORIZED" });

    const duplicate = createClient(url, { transports: ["websocket"] });
    clients.push(duplicate);
    await waitForConnect(duplicate);
    const duplicateResult = await new Promise<Ack<SessionCredentials>>((resolve) =>
      duplicate.emit("room:join", { nickname: " 玩家2 ", roomCode: hostCredentials.roomCode }, resolve),
    );
    expect(duplicateResult).toMatchObject({ ok: false, code: "DUPLICATE_NICKNAME" });

    guest.close();
    const resumed = createClient(url, { transports: ["websocket"] });
    clients.push(resumed);
    await waitForConnect(resumed);
    const recoveredPromise = waitForSnapshot(resumed, (snapshot) => snapshot.selfId === guestCredentials.playerId);
    const resumeResult = await new Promise<Ack>((resolve) => resumed.emit("room:resume", guestCredentials, resolve));
    expect(resumeResult).toEqual({ ok: true });
    const recovered = await recoveredPromise;
    expect(recovered.players.every((player) => !("role" in player))).toBe(true);

    for (const client of clients.splice(0)) client.close();
    await app.close();
  }, 15_000);
});
