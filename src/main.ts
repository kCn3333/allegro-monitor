import { buildApp } from "./server.js";
import { config } from "./config.js";
const app = await buildApp();
const shutdown = async () => { await app.close(); };
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await app.listen({ port: config.port, host: config.host });
