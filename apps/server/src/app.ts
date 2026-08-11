import { Hono } from "hono";
import { authRoutes } from "./http/auth.routes";
import { providerRoutes } from "./http/providers.routes";
import { nodeRoutes } from "./http/nodes.routes";
import { installScript, daemonBundle } from "./http/install";
import { errorResponse, withActor, type Env } from "./http/context";
import { serveStatic } from "./http/static";

/* The app, separate from the listener, so tests can drive it with app.request()
   without binding a port. */

export const app = new Hono<Env>();

app.onError(errorResponse);

app.get("/healthz", (c) => c.text("ok\n"));

app.use("/api/*", withActor);
app.route("/api/auth", authRoutes);
app.route("/api/providers", providerRoutes);
app.route("/api/nodes", nodeRoutes);

/* The one-command install. The token is the path segment, so the script comes
   back already carrying the origin and the token — no editing, no copy-paste
   of a second value. Served without a session: the token is the credential. */
app.get("/install/:token", (c) => installScript(c.req.param("token")));
app.get("/install/:token/daemon.js", () => daemonBundle());

/* An unmatched API path is a 404 in JSON. Only non-API paths fall through to
   the SPA. */
app.all("/api/*", (c) => c.json({ error: "No such endpoint." }, 404));

app.get("*", (c) => serveStatic(new URL(c.req.url).pathname));
