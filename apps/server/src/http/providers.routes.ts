import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { encryptSecret } from "../lib/crypto";
import { adapterFor } from "../providers/gateway";
import { ProviderError } from "../providers/types";
import { BadRequest, NotFound, requireActor, activeScope, type Env } from "./context";
import { assertCan, providerScope } from "../lib/permissions";
import { record } from "../lib/audit";

export const providerRoutes = new Hono<Env>();

const CreateProvider = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(["openai_compatible"]),
  baseUrl: z.url("Enter the full base URL, ending in /v1."),
  apiKey: z.string().min(1, "Enter the API key."),
});

/* Credentials are write-only. Every response here is deliberately built field
   by field rather than spreading the row, so a future column cannot leak the
   encrypted key by being added to the table. */
function publicView(row: typeof schema.providerConnections.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    lastHealthAt: row.lastHealthAt,
    lastHealthOk: row.lastHealthOk,
    createdAt: row.createdAt,
  };
}

providerRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.read", scope);

  const rows = await db
    .select()
    .from(schema.providerConnections)
    .where(
      scope.ownerOrgId
        ? eq(schema.providerConnections.ownerOrgId, scope.ownerOrgId)
        : eq(schema.providerConnections.ownerUserId, actor.id),
    );

  const withModels = await Promise.all(
    rows.map(async (row) => ({
      ...publicView(row),
      models: await db
        .select({
          id: schema.models.id,
          modelId: schema.models.modelId,
          tier: schema.models.tier,
          contextWindow: schema.models.contextWindow,
          enabled: schema.models.enabled,
          /* Surfaced so the UI can grey out a model and say why, rather than
             hiding it and leaving the user wondering where it went. */
          probeOk: schema.models.probeOk,
          probeError: schema.models.probeError,
        })
        .from(schema.models)
        .where(eq(schema.models.providerId, row.id)),
    })),
  );

  return c.json({ providers: withModels });
});

providerRoutes.post("/", async (c) => {
  const actor = requireActor(c);
  const parsed = CreateProvider.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new BadRequest("Check the form.", z.flattenError(parsed.error).fieldErrors);
  }

  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);

  const row = {
    id: crypto.randomUUID(),
    ownerUserId: scope.ownerOrgId ? null : actor.id,
    ownerOrgId: scope.ownerOrgId,
    name: parsed.data.name,
    kind: parsed.data.kind,
    baseUrl: parsed.data.baseUrl.replace(/\/+$/, ""),
    encryptedKey: encryptSecret(parsed.data.apiKey),
    enabled: true,
    lastHealthAt: null,
    lastHealthOk: null,
    createdAt: Date.now(),
  };

  await db.insert(schema.providerConnections).values(row);
  /* The key itself is never logged — only that a connection was added, by whom
     and to where. */
  await record(scope.ownerOrgId, actor, "provider.added", row.id, {
    name: row.name,
    baseUrl: row.baseUrl,
  });
  return c.json({ provider: publicView(row) }, 201);
});

/* Probes the provider and records the model list. Separate from creation so a
   provider that is temporarily down can still be saved and refreshed later. */
providerRoutes.post("/:id/refresh", async (c) => {
  const actor = requireActor(c);
  const scope = await providerScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "provider.manage", scope);

  const [row] = await db
    .select()
    .from(schema.providerConnections)
    .where(eq(schema.providerConnections.id, c.req.param("id")))
    .limit(1);

  if (!row) throw new NotFound();

  /* Probing costs a few tokens per model and takes a few seconds, so it is
     opt-out rather than automatic on every refresh. It is on by default because
     a model list that lies is worse than a short one — this provider advertises
     26 models and can actually route 18. */
  const shouldProbe = c.req.query("probe") !== "0";

  try {
    const adapter = adapterFor(row);
    const models = await adapter.listModels();

    for (const model of models) {
      await db
        .insert(schema.models)
        .values({
          id: crypto.randomUUID(),
          providerId: row.id,
          modelId: model.id,
          tier: "standard",
          contextWindow: model.contextWindow ?? null,
          priceInPerMTok: model.priceInPerMTok ?? null,
          priceOutPerMTok: model.priceOutPerMTok ?? null,
          enabled: true,
        })
        .onConflictDoNothing();
    }

    let usable = models.length;

    if (shouldProbe) {
      const results = await mapWithConcurrency(models, 6, async (model) => ({
        modelId: model.id,
        result: await adapter.probe(model.id),
      }));

      usable = results.filter((r) => r.result.ok).length;

      for (const { modelId, result } of results) {
        await db
          .update(schema.models)
          .set({
            probedAt: Date.now(),
            probeOk: result.ok,
            probeError: result.error ?? null,
            needsReasoningEffort: result.needsReasoningEffort ?? false,
          })
          .where(and(eq(schema.models.providerId, row.id), eq(schema.models.modelId, modelId)));
      }
    }

    await db
      .update(schema.providerConnections)
      .set({ lastHealthAt: Date.now(), lastHealthOk: true })
      .where(eq(schema.providerConnections.id, row.id));

    return c.json({ count: models.length, usable, probed: shouldProbe });
  } catch (err) {
    await db
      .update(schema.providerConnections)
      .set({ lastHealthAt: Date.now(), lastHealthOk: false })
      .where(eq(schema.providerConnections.id, row.id));

    if (err instanceof ProviderError) {
      return c.json({ error: err.message, retryable: err.retryable }, 502);
    }
    throw err;
  }
});

/* Probing 26 models serially would take most of a minute. Bounded concurrency
   keeps it quick without opening 26 sockets at a rate limiter. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    }),
  );

  return results;
}

providerRoutes.delete("/:id", async (c) => {
  const actor = requireActor(c);
  const scope = await providerScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "provider.manage", scope);

  await db
    .delete(schema.providerConnections)
    .where(eq(schema.providerConnections.id, c.req.param("id")));

  await record(scope.ownerOrgId ?? null, actor, "provider.removed", c.req.param("id"));
  return c.json({ ok: true });
});
