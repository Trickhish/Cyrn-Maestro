import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { encryptSecret } from "../lib/crypto";
import { assertCan, projectScope } from "../lib/permissions";
import { record } from "../lib/audit";
import { listTools } from "../mcp/client";
import { BadRequest, NotFound, requireActor, type Env } from "./context";

export const mcpRoutes = new Hono<Env>();

const ServerInput = z.object({
  projectId: z.string(),
  name: z
    .string()
    .min(1)
    .max(40)
    /* The name becomes the tool namespace, so it has to be safe in a tool name
       and free of the separator. */
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and hyphens."),
  placement: z.enum(["server", "node"]).default("server"),
  url: z.url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  command: z.string().max(200).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  toolAllowlist: z.array(z.string()).optional(),
  approval: z.enum(["auto", "ask", "never"]).optional(),
  enabled: z.boolean().optional(),
});

/* Credentials never come back out. The interface is told whether headers are
   set, never what they contain. */
function publicView(row: typeof schema.mcpServers.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    placement: row.placement,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args,
    hasHeaders: Boolean(row.encryptedHeaders),
    hasEnv: Boolean(row.encryptedEnv),
    enabled: row.enabled,
    toolAllowlist: row.toolAllowlist,
    approval: row.approval,
    lastError: row.lastError,
    lastConnectedAt: row.lastConnectedAt,
  };
}

mcpRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const projectId = c.req.query("projectId");
  if (!projectId) throw new BadRequest("Name a project.");

  const scope = await projectScope(projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.read", scope);

  const rows = await db
    .select()
    .from(schema.mcpServers)
    .where(eq(schema.mcpServers.projectId, projectId));

  return c.json({ servers: rows.map(publicView) });
});

mcpRoutes.post("/", async (c) => {
  const actor = requireActor(c);
  const parsed = ServerInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new BadRequest("Check the form.", z.flattenError(parsed.error).fieldErrors);
  }

  const scope = await projectScope(parsed.data.projectId);
  if (!scope) throw new NotFound();
  /* Connecting a tool source changes what every future task in this project can
     reach, so it is a project change rather than something any member may do. */
  await assertCan(actor, "project.update", scope);

  const placement = parsed.data.placement;
  if (placement === "server" && !parsed.data.url) {
    throw new BadRequest("A server-side MCP connection needs a URL.");
  }
  if (placement === "node" && !parsed.data.command) {
    throw new BadRequest("A node-side MCP server needs a command to run.");
  }

  const row = {
    id: crypto.randomUUID(),
    projectId: parsed.data.projectId,
    name: parsed.data.name,
    placement,
    transport: (placement === "server" ? "http" : "stdio") as "http" | "stdio",
    url: parsed.data.url ?? null,
    encryptedHeaders: parsed.data.headers ? encryptSecret(JSON.stringify(parsed.data.headers)) : null,
    command: parsed.data.command ?? null,
    args: parsed.data.args ?? null,
    encryptedEnv: parsed.data.env ? encryptSecret(JSON.stringify(parsed.data.env)) : null,
    enabled: parsed.data.enabled ?? true,
    toolAllowlist: parsed.data.toolAllowlist ?? [],
    approval: parsed.data.approval ?? ("ask" as const),
    lastError: null,
    lastConnectedAt: null,
    createdAt: Date.now(),
  };

  await db.insert(schema.mcpServers).values(row);
  await record(scope.ownerOrgId ?? null, actor, "mcp.connected", row.id, {
    name: row.name,
    placement,
  });

  return c.json({ server: publicView(row as never) }, 201);
});

/* Lists what a configured server actually offers, so the tool picker shows real
   names rather than asking someone to type them from memory. */
mcpRoutes.post("/:id/tools", async (c) => {
  const actor = requireActor(c);

  const [row] = await db
    .select()
    .from(schema.mcpServers)
    .where(eq(schema.mcpServers.id, c.req.param("id")))
    .limit(1);
  if (!row) throw new NotFound();

  const scope = await projectScope(row.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.update", scope);

  if (row.placement === "node") {
    return c.json({ tools: [], note: "Node-side MCP servers are not started yet." });
  }

  try {
    const { decryptSecret } = await import("../lib/crypto");
    const tools = await listTools({
      name: row.name,
      url: row.url ?? "",
      headers: row.encryptedHeaders ? JSON.parse(decryptSecret(row.encryptedHeaders)) : undefined,
      /* Deliberately unfiltered: this is the picker, so it has to show what is
         available rather than what is already chosen. */
      toolAllowlist: [],
    });

    await db
      .update(schema.mcpServers)
      .set({ lastConnectedAt: Date.now(), lastError: null })
      .where(eq(schema.mcpServers.id, row.id));

    return c.json({
      tools: tools.map((t) => ({ name: t.toolName, description: t.description })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.mcpServers)
      .set({ lastError: message })
      .where(eq(schema.mcpServers.id, row.id));
    return c.json({ error: message }, 502);
  }
});

mcpRoutes.patch("/:id", async (c) => {
  const actor = requireActor(c);

  const [row] = await db
    .select()
    .from(schema.mcpServers)
    .where(eq(schema.mcpServers.id, c.req.param("id")))
    .limit(1);
  if (!row) throw new NotFound();

  const scope = await projectScope(row.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.update", scope);

  const parsed = ServerInput.partial().safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Check the form.");

  await db
    .update(schema.mcpServers)
    .set({
      ...(parsed.data.url !== undefined ? { url: parsed.data.url } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.approval !== undefined ? { approval: parsed.data.approval } : {}),
      ...(parsed.data.toolAllowlist !== undefined
        ? { toolAllowlist: parsed.data.toolAllowlist }
        : {}),
      /* Omitted headers keep the stored ones, same reasoning as the SMTP
         password: the interface never receives them to resubmit. */
      ...(parsed.data.headers !== undefined
        ? { encryptedHeaders: encryptSecret(JSON.stringify(parsed.data.headers)) }
        : {}),
    })
    .where(eq(schema.mcpServers.id, row.id));

  await record(scope.ownerOrgId ?? null, actor, "mcp.changed", row.id, { name: row.name });
  return c.json({ ok: true });
});

mcpRoutes.delete("/:id", async (c) => {
  const actor = requireActor(c);

  const [row] = await db
    .select()
    .from(schema.mcpServers)
    .where(eq(schema.mcpServers.id, c.req.param("id")))
    .limit(1);
  if (!row) throw new NotFound();

  const scope = await projectScope(row.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.update", scope);

  await db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, row.id));
  await record(scope.ownerOrgId ?? null, actor, "mcp.removed", row.id, { name: row.name });

  return c.json({ ok: true });
});
