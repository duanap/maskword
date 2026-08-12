import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { Server as SocketServer } from "socket.io";
import type {
  Ack,
  ClientToServerEvents,
  ErrorCode,
  ServerToClientEvents,
  SessionCredentials,
} from "@maskword/shared";
import { GAME_CONFIG, SERVER_CONFIG } from "./config.js";
import { GameError, RoomService } from "./game/room-service.js";

function failure<T = undefined>(error: unknown): Ack<T> {
  if (error instanceof GameError) return { ok: false, code: error.code, message: error.message };
  console.error(error);
  return { ok: false, code: "INTERNAL_ERROR" satisfies ErrorCode, message: "服务暂时异常，请稍后重试" };
}

function ok<T>(data?: T): Ack<T> {
  return (data === undefined ? { ok: true } : { ok: true, data }) as Ack<T>;
}

export async function createApp(roomService = new RoomService()) {
  const app = Fastify({ logger: true });
  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(app.server, {
    cors: { origin: false },
    transports: ["websocket", "polling"],
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "maskword",
    roomCount: roomService.getRoomCount(),
    timestamp: new Date().toISOString(),
  }));

  const webDist = SERVER_CONFIG.webDistPath
    ? path.resolve(SERVER_CONFIG.webDistPath)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/socket.io/")) {
        void reply.code(404).send({ ok: false, message: "Not found" });
        return;
      }
      void reply.sendFile("index.html");
    });
  } else {
    app.log.warn("Web build not found; API and Socket.IO remain available.");
  }

  const publishRoom = (roomCode: string) => {
    for (const { socketId, snapshot } of roomService.snapshotsForRoom(roomCode)) {
      io.to(socketId).emit("room:snapshot", snapshot);
    }
  };

  roomService.setCallbacks({
    onRoomUpdated: publishRoom,
    onRoomClosed: (_roomCode, reason, socketIds) => {
      for (const socketId of socketIds) io.to(socketId).emit("room:closed", { reason });
    },
  });

  io.on("connection", (socket) => {
    const guarded = (action: () => void, ack: (result: Ack) => void) => {
      try {
        action();
        ack(ok());
      } catch (error) {
        ack(failure(error));
      }
    };

    socket.on("room:create", (input, ack) => {
      try {
        const credentials = roomService.createRoom(input.nickname, input.config, socket.id, input.customWords);
        socket.join(credentials.roomCode);
        ack(ok<SessionCredentials>(credentials));
        publishRoom(credentials.roomCode);
      } catch (error) {
        ack(failure<SessionCredentials>(error));
      }
    });

    socket.on("room:join", (input, ack) => {
      try {
        const credentials = roomService.joinRoom(input.nickname, input.roomCode, socket.id);
        socket.join(credentials.roomCode);
        ack(ok<SessionCredentials>(credentials));
        publishRoom(credentials.roomCode);
      } catch (error) {
        ack(failure<SessionCredentials>(error));
      }
    });

    socket.on("room:resume", (input, ack) => {
      try {
        roomService.resumeRoom(input, socket.id);
        socket.join(input.roomCode);
        ack(ok());
        publishRoom(input.roomCode);
      } catch (error) {
        ack(failure(error));
      }
    });

    socket.on("room:leave", (ack) => guarded(() => roomService.leaveRoom(socket.id), ack));
    socket.on("room:dissolve", (ack) => guarded(() => roomService.dissolveRoom(socket.id), ack));
    socket.on("room:transferHost", (targetId, ack) => guarded(() => roomService.transferHost(socket.id, targetId), ack));
    socket.on("room:changeAvatar", (avatarId, ack) => guarded(() => roomService.changeAvatar(socket.id, avatarId), ack));
    socket.on("game:start", (ack) => guarded(() => roomService.startGame(socket.id), ack));
    socket.on("game:startSpeaking", (ack) => guarded(() => roomService.startSpeaking(socket.id), ack));
    socket.on("game:endSpeaking", (ack) => guarded(() => roomService.endSpeaking(socket.id), ack));
    socket.on("game:beginVote", (ack) => guarded(() => roomService.beginVote(socket.id), ack));
    socket.on("game:advanceRound", (ack) => guarded(() => roomService.advanceRound(socket.id), ack));
    socket.on("vote:submit", (submission, ack) => guarded(() => roomService.submitVote(socket.id, submission), ack));
    socket.on("vote:finishRunoff", (ack) => guarded(() => roomService.finishRunoff(socket.id), ack));
    socket.on("game:rematch", (ack) => guarded(() => roomService.rematch(socket.id), ack));
    socket.on("disconnect", () => roomService.disconnect(socket.id));
  });

  const cleanupTimer = setInterval(() => roomService.cleanupExpiredRooms(), GAME_CONFIG.cleanupIntervalMs);
  cleanupTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    io.close();
  });

  return { app, io, roomService };
}
