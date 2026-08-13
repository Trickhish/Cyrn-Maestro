import { NODE_VERSION } from "@maestro/protocol";
import { app } from "./app";
import { config } from "./config";
import { buildDaemonBundle, daemonDigest } from "./http/install";
import { handleNodeMessage, handleDisconnect, type SocketSession } from "./nodes/registry";

import { recoverOrphanedTasks } from "./tasks/recovery";
import { backfillModelPrices } from "./providers/backfill";

/* Fail at boot rather than at the first request that needs a key. */
config.secretKey();

/* Tasks whose loop died with a previous process cannot be resumed, and left
   alone they show a spinner forever and hold a node slot. Fail them honestly
   before accepting traffic. */
const recovered = await recoverOrphanedTasks();
if (recovered > 0) {
  console.log(`recovered        ${recovered} task${recovered === 1 ? "" : "s"} orphaned by a restart`);
}

/* Models stored before there was a price table record no cost, which makes
   every spend cap over them decorative. Priced here so an existing instance is
   protected without anyone having to know to press Refresh. */
const priced = await backfillModelPrices();
if (priced > 0) {
  console.log(`priced           ${priced} model${priced === 1 ? "" : "s"} from the price table`);
}

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

  /* Bun closes an idle request after 10 seconds by default, which is shorter
     than two things this server legitimately does: probing a provider's whole
     model list, and holding an SSE stream open between events. Both look idle
     from the socket's point of view. */
  idleTimeout: 255,

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

/* Built now rather than on the first install or update request: it takes a
   moment, and a node asking whether it is out of date should not be the thing
   that waits for it. */
void buildDaemonBundle().then(async () => {
  const digest = await daemonDigest();
  console.log(`node daemon     ${NODE_VERSION}${digest ? ` (${digest.slice(0, 12)})` : " — build failed"}`);
});
