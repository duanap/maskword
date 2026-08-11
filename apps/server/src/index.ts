import { createApp } from "./app.js";
import { SERVER_CONFIG } from "./config.js";

const { app } = await createApp();

try {
  await app.listen({ host: SERVER_CONFIG.host, port: SERVER_CONFIG.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
