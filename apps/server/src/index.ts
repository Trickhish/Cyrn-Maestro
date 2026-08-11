import { app } from "./app";
import { config } from "./config";

/* Fail at boot rather than at the first request that needs a key. */
config.secretKey();

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
});

console.log(`maestro server → http://${server.hostname}:${server.port}`);
console.log(`database        ${config.dbPath}`);
console.log(`serving         ${config.webDist}`);
