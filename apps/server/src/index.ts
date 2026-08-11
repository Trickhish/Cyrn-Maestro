import { app } from "./app";
import { config } from "./config";
import { handleNodeMessage, handleDisconnect, type SocketSession } from "./nodes/registry";

/* Fail at boot rather than at the first request that needs a key. */
config.secretKey();

/* Node sockets are handled by Bun directly rather than through Hono: the
 * upgrade has to happen on the raw request, before any framework has consumed
 * it. Everything else falls through to the app.
 *
 * There is deliberately no session check on the upgrade. A node authenticates
 * with its own token in the first frame, not with a browser cookie — it is a
 * daemon on someone's laptop, not a logged-in user. */

const NODE_SOCKET_PATH = "/api/node/socket";

const server = Bun.serve<{ session: SocketSession }, never>({
  port: config.port,
  hostname: config.host,

  fetch(request, srv) {
    const url = new URL(request.url);

    if (url.pathname === NODE_SOCKET_PATH) {
      const upgraded = srv.upgrade(request, { data: { session: {} as SocketSession } });
      if (upgraded) return undefined;
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }

    return app.fetch(request);
  },

  websocket: {
    /* Long-running tool output can be large; the default would drop frames. */
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout: 120,

    async message(ws, raw) {
      await handleNodeMessage(ws.data.session, ws, String(raw));
    },

    async close(ws) {
      await handleDisconnect(ws.data.session);
    },
  },
});

console.log(`maestro server → http://${server.hostname}:${server.port}`);
console.log(`node socket     ws://${server.hostname}:${server.port}${NODE_SOCKET_PATH}`);
console.log(`database        ${config.dbPath}`);
console.log(`serving         ${config.webDist}`);
