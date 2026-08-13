import { Hono } from "hono";
import { authRoutes } from "./http/auth.routes";
import { providerRoutes } from "./http/providers.routes";
import { nodeRoutes } from "./http/nodes.routes";
import { projectRoutes } from "./http/projects.routes";
import { taskRoutes } from "./http/tasks.routes";
import { conductorRoutes } from "./http/conductor.routes";
import { orgRoutes } from "./http/orgs.routes";
import { accountRoutes } from "./http/account.routes";
import { instanceRoutes } from "./http/instance.routes";
import { ruleRoutes } from "./http/rules.routes";
import { mcpRoutes } from "./http/mcp.routes";
import { knowledgeRoutes } from "./http/knowledge.routes";
import { modelListRoutes } from "./http/model-lists.routes";
import { modelGroupRoutes } from "./http/model-groups.routes";
import { installScript, daemonBundle } from "./http/install";
import { isActiveNodeToken } from "./nodes/registry";
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
app.route("/api/projects", projectRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/conductor", conductorRoutes);
app.route("/api/orgs", orgRoutes);
app.route("/api/account", accountRoutes);
app.route("/api/instance", instanceRoutes);
app.route("/api/rules", ruleRoutes);
app.route("/api/mcp", mcpRoutes);
app.route("/api/knowledge", knowledgeRoutes);
app.route("/api/model-lists", modelListRoutes);
app.route("/api/model-groups", modelGroupRoutes);

/* The one-command install. The token is the path segment, so the script comes
   back already carrying the origin and the token — no editing, no copy-paste
   of a second value. Served without a session: the token is the credential. */
app.get("/install/:token", (c) => installScript(c.req.param("token")));
app.get("/install/:token/daemon.js", () => daemonBundle());

/* The same bundle, for a node that is already enrolled and updating itself.
 *
 * Its durable token rather than an enrollment one, since enrollment tokens are
 * single-use and long spent by then. Worth being clear about what this hands
 * over: the bundle is the whole daemon, including the approval policy the
 * machine's owner relies on to gate writes. Updating therefore trusts this
 * server with the code that enforces that policy, which is a broader trust
 * than running the tasks it sends. That is why it is a button someone presses
 * and not something that happens on its own. */
app.get("/api/node/daemon.js", async (c) => {
  const token = c.req.header("x-maestro-node-token");
  if (!token || !(await isActiveNodeToken(token))) {
    return c.json({ error: "Not a known node." }, 401);
  }
  return daemonBundle();
});

/* An unmatched API path is a 404 in JSON. Only non-API paths fall through to
   the SPA. */
app.all("/api/*", (c) => c.json({ error: "No such endpoint." }, 404));

app.get("*", (c) => serveStatic(new URL(c.req.url).pathname));
