import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { encryptSecret } from "../lib/crypto";
import { assertCan } from "../lib/permissions";
import { record } from "../lib/audit";
import { listTools, NAMESPACE_SEPARATOR } from "../mcp/client";
import { discoverGateway, GatewayError } from "../mcp/gateway";
import { BadRequest, NotFound, requireActor, activeScope, type Env } from "./context";

export const mcpRoutes = new Hono<Env>();

function ownedBy(scope: { ownerUserId?: string | null; ownerOrgId?: string | null }) {
  return scope.ownerOrgId
    ? eq(schema.mcpServers.ownerOrgId, scope.ownerOrgId)
    : eq(schema.mcpServers.ownerUserId, scope.ownerUserId!);
}

/* The name becomes the tool namespace, so it has to be safe inside a tool name
   and must not contain the separator itself. A single underscore is fine —
   unqualify() splits on the first "__", so "web_tools__dns" resolves correctly
   — and forbidding it would lock out real service names for no gain. */
const serverName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, hyphens and underscores.")
  .refine((v) => !v.includes(NAMESPACE_SEPARATOR), {
    message: `A name cannot contain "${NAMESPACE_SEPARATOR}" — that separates the server from the tool.`,
  });

const ServerInput = z.object({
  name: serverName,
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

/* Owner-wide: whichever organization you are working in, or your own account.
   A connection to GitHub is a fact about the team rather than about one
   repository, so it is configured once and available to every project. */
mcpRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.read", scope);

  const rows = await db.select().from(schema.mcpServers).where(ownedBy(scope));
  return c.json({ servers: rows.map(publicView) });
});

mcpRoutes.post("/", async (c) => {
  const actor = requireActor(c);
  const parsed = ServerInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new BadRequest("Check the form.", z.flattenError(parsed.error).fieldErrors);
  }

  const scope = activeScope(c);
  /* Connecting a tool source changes what every future task can reach, so it
     needs the same authority as adding a provider — not something any member
     may do. */
  await assertCan(actor, "provider.manage", scope);

  const placement = parsed.data.placement;
  if (placement === "server" && !parsed.data.url) {
    throw new BadRequest("A server-side MCP connection needs a URL.");
  }
  if (placement === "node" && !parsed.data.command) {
    throw new BadRequest("A node-side MCP server needs a command to run.");
  }

  const row = {
    id: crypto.randomUUID(),
    ownerUserId: scope.ownerOrgId ? null : actor.id,
    ownerOrgId: scope.ownerOrgId,
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

/* --- gateways -------------------------------------------------------------
 *
 * A gateway fronts several MCP services on one host behind one key. Importing
 * from it creates one ordinary server row per service, so everything after this
 * point — listing tools, approvals, calling them — is the existing path.
 *
 * The key is sent twice by the browser, once to look and once to import, so a
 * gateway someone decides against leaves nothing stored. */

const Discover = z.object({ baseUrl: z.string().min(1), token: z.string().min(1) });

mcpRoutes.post("/gateway/discover", async (c) => {
  const actor = requireActor(c);
  const parsed = Discover.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("A gateway URL and a key are both needed.");

  const scope = activeScope(c);
  /* Reaching an arbitrary URL with a supplied credential is the same authority
     as connecting a server, so it takes the same permission. */
  await assertCan(actor, "provider.manage", scope);

  try {
    const { base, services } = await discoverGateway(parsed.data.baseUrl, parsed.data.token);

    /* Which are already here, so the interface can say so rather than letting
       someone create a duplicate that then collides on its namespace. */
    const existing = await db.select().from(schema.mcpServers).where(ownedBy(scope));
    const taken = new Set(existing.map((row) => row.name));

    return c.json({
      base,
      services: services.map((service) => ({ ...service, alreadyAdded: taken.has(service.id) })),
    });
  } catch (err) {
    if (err instanceof GatewayError) return c.json({ error: err.message }, 502);
    throw err;
  }
});

const Import = Discover.extend({
  serviceIds: z.array(z.string().min(1)).min(1),
  approval: z.enum(["auto", "ask", "never"]).default("ask"),
});

mcpRoutes.post("/gateway/import", async (c) => {
  const actor = requireActor(c);
  const parsed = Import.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Pick at least one service.");

  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);

  let discovered: Awaited<ReturnType<typeof discoverGateway>>;
  try {
    /* Re-discovered rather than trusted from the browser: the URL a service is
       reached at comes from the gateway, not from whoever posted the form. */
    discovered = await discoverGateway(parsed.data.baseUrl, parsed.data.token);
  } catch (err) {
    if (err instanceof GatewayError) return c.json({ error: err.message }, 502);
    throw err;
  }

  const existing = await db.select().from(schema.mcpServers).where(ownedBy(scope));
  const taken = new Set(existing.map((row) => row.name));

  const wanted = new Set(parsed.data.serviceIds);
  const added: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const service of discovered.services) {
    if (!wanted.has(service.id)) continue;
    wanted.delete(service.id);

    if (taken.has(service.id)) {
      skipped.push({ id: service.id, reason: "A server of that name is already connected." });
      continue;
    }

    const name = serverName.safeParse(service.id);
    if (!name.success) {
      skipped.push({ id: service.id, reason: "Its name cannot be used as a tool prefix." });
      continue;
    }

    const row = {
      id: crypto.randomUUID(),
      ownerUserId: scope.ownerOrgId ? null : actor.id,
      ownerOrgId: scope.ownerOrgId,
      name: service.id,
      placement: "server" as const,
      transport: "http" as const,
      url: service.url,
      encryptedHeaders: encryptSecret(
        JSON.stringify({ Authorization: `Bearer ${parsed.data.token}` }),
      ),
      command: null,
      args: null,
      encryptedEnv: null,
      enabled: true,
      toolAllowlist: [] as string[],
      approval: parsed.data.approval,
      lastError: null,
      lastConnectedAt: null,
      createdAt: Date.now(),
    };

    await db.insert(schema.mcpServers).values(row);
    await record(scope.ownerOrgId ?? null, actor, "mcp.connected", row.id, {
      name: row.name,
      placement: "server",
      gateway: discovered.base,
    });

    taken.add(service.id);
    added.push(service.id);
  }

  for (const id of wanted) {
    skipped.push({ id, reason: "The gateway does not offer that service to this key." });
  }

  return c.json({ added, skipped });
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

  const scope = { ownerUserId: row.ownerUserId, ownerOrgId: row.ownerOrgId };
  await assertCan(actor, "provider.manage", scope);

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

  const scope = { ownerUserId: row.ownerUserId, ownerOrgId: row.ownerOrgId };
  await assertCan(actor, "provider.manage", scope);

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

  const scope = { ownerUserId: row.ownerUserId, ownerOrgId: row.ownerOrgId };
  await assertCan(actor, "provider.manage", scope);

  await db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, row.id));
  await record(scope.ownerOrgId ?? null, actor, "mcp.removed", row.id, { name: row.name });

  return c.json({ ok: true });
});
