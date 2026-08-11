import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { encryptSecret } from "../lib/crypto";
import { adapterFor } from "../providers/gateway";
import { ProviderError } from "../providers/types";
import { BadRequest, NotFound, requireActor, type Env } from "./context";

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
  const rows = await db
    .select()
    .from(schema.providerConnections)
    .where(eq(schema.providerConnections.ownerUserId, actor.id));

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

  const row = {
    id: crypto.randomUUID(),
    ownerUserId: actor.id,
    ownerOrgId: null,
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
  return c.json({ provider: publicView(row) }, 201);
});

/* Probes the provider and records the model list. Separate from creation so a
   provider that is temporarily down can still be saved and refreshed later. */
providerRoutes.post("/:id/refresh", async (c) => {
  const actor = requireActor(c);
  const [row] = await db
    .select()
    .from(schema.providerConnections)
    .where(
      and(
        eq(schema.providerConnections.id, c.req.param("id")),
        eq(schema.providerConnections.ownerUserId, actor.id),
      ),
    )
    .limit(1);

  if (!row) throw new NotFound();

  try {
    const models = await adapterFor(row).listModels();

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

    await db
      .update(schema.providerConnections)
      .set({ lastHealthAt: Date.now(), lastHealthOk: true })
      .where(eq(schema.providerConnections.id, row.id));

    return c.json({ models: models.map((m) => m.id), count: models.length });
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

providerRoutes.delete("/:id", async (c) => {
  const actor = requireActor(c);
  const deleted = await db
    .delete(schema.providerConnections)
    .where(
      and(
        eq(schema.providerConnections.id, c.req.param("id")),
        eq(schema.providerConnections.ownerUserId, actor.id),
      ),
    )
    .returning({ id: schema.providerConnections.id });

  if (deleted.length === 0) throw new NotFound();
  return c.json({ ok: true });
});
