import { Hono } from "hono";
import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { encryptSecret } from "../lib/crypto";
import { adapterFor } from "../providers/gateway";
import { inferTier } from "../router/weigh";
import { inferPrice } from "../providers/pricing";
import { ProviderError } from "../providers/types";
import { BadRequest, NotFound, requireActor, activeScope, type Env } from "./context";
import { assertCan, providerScope } from "../lib/permissions";
import { record } from "../lib/audit";

export const providerRoutes = new Hono<Env>();

/* A model's price and where it came from.
 *
 * The provider's own number is authoritative when there is one. Almost none of
 * them publish one on /v1/models, so the fallback is the name-based table —
 * without it every task records $0 and every spend cap is decorative. */
function priceFor(model: { id: string; priceInPerMTok?: number; priceOutPerMTok?: number }) {
  if (model.priceInPerMTok != null || model.priceOutPerMTok != null) {
    return {
      priceInPerMTok: model.priceInPerMTok ?? null,
      priceOutPerMTok: model.priceOutPerMTok ?? null,
      priceSource: "provider" as const,
    };
  }

  const guess = inferPrice(model.id);
  return {
    priceInPerMTok: guess?.inPerMTok ?? null,
    priceOutPerMTok: guess?.outPerMTok ?? null,
    /* Null source for an unknown model, so a later table improvement reaches
       it — and so the UI can tell "unpriced" from "priced at zero". */
    priceSource: guess ? ("inferred" as const) : null,
  };
}

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
          tierSource: schema.models.tierSource,
          contextWindow: schema.models.contextWindow,
          enabled: schema.models.enabled,
          /* Surfaced so a cap can be shown as unenforceable when the models it
             would govern have no price. */
          priceInPerMTok: schema.models.priceInPerMTok,
          priceOutPerMTok: schema.models.priceOutPerMTok,
          priceSource: schema.models.priceSource,
          /* Surfaced so the UI can grey out a model and say why, rather than
             hiding it and leaving the user wondering where it went. */
          probeOk: schema.models.probeOk,
          probeError: schema.models.probeError,
          /* What the models are grouped by: one connection to a proxy can
             front a dozen upstreams, and they fail and cost separately. */
          ownedBy: schema.models.ownedBy,
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

  /* Probing costs a real API call per model — two, for the ones that need a
     reasoning retry. That is worth it for a list of twenty and absurd for a
     gateway advertising several hundred: minutes of waiting, hundreds of
     billable calls, and a rate limit hit partway through.
   *
     So it is capped. Models past the cap keep probeOk = null, which already
     means "not known to be broken" everywhere it is read — they stay usable
     and simply carry no verdict, and one that turns out not to work surfaces
     the provider's own error at the moment it is used.
   *
     ?probe=0 skips entirely; ?probe=all forces the whole list. */
  const probeMode = c.req.query("probe") ?? "";
  const shouldProbe = probeMode !== "0";
  const probeLimit = probeMode === "all" ? Number.POSITIVE_INFINITY : PROBE_LIMIT;

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
          /* First automatic classification, from the model's name. An admin
             can correct it afterwards, and that correction sticks. */
          tier: inferTier(model.id),
          tierSource: "inferred",
          contextWindow: model.contextWindow ?? null,
          ownedBy: model.ownedBy ?? null,
          /* A price the provider published wins; otherwise the name is used,
             because a model with no price accrues no spend and slips past
             every cap. */
          ...priceFor(model),
          enabled: true,
        })
        .onConflictDoNothing();

      /* The insert above does nothing for a model already on file, so who
         serves it would never reach an existing row — and every catalogue
         that predates this column would stay ungrouped until each model
         happened to be re-added. Kept current rather than set once: a proxy
         can move a model between upstreams. */
      if (model.ownedBy || model.root || model.parent) {
        await db
          .update(schema.models)
          .set({
            ...(model.ownedBy ? { ownedBy: model.ownedBy } : {}),
            ...(model.root ? { root: model.root } : {}),
            ...(model.parent ? { parent: model.parent } : {}),
          })
          .where(and(eq(schema.models.providerId, row.id), eq(schema.models.modelId, model.id)));
      }
    }

    /* A refresh is what the provider offers now, not everything it has ever
       offered. Without this, models withdrawn upstream stay in the picker and
       in every list forever — and the count quietly drifts, which is how a
       catalogue ends up half stale with nothing saying so.
     *
       Skipped when the listing came back empty: a provider having a bad
       moment must not be read as "it offers nothing", which would delete the
       whole catalogue and take every hand-set tier and price with it. */
    let removed = 0;
    if (models.length > 0) {
      const offered = models.map((m) => m.id);
      const gone = await db
        .delete(schema.models)
        .where(and(eq(schema.models.providerId, row.id), notInArray(schema.models.modelId, offered)))
        .returning({ id: schema.models.id });
      removed = gone.length;
    }

    const collapsed = await collapseAliases(row.id, models);

    let usable = models.length;
    let probed = 0;

    if (shouldProbe) {
      /* Probe the ones most likely to be reached first, so a capped run still
         verifies what the router would actually pick. */
      const ordered = [...models].sort((a, b) => rankForProbing(a.id) - rankForProbing(b.id));
      const toProbe = ordered.slice(0, probeLimit);

      const results = await mapWithConcurrency(toProbe, 6, async (model) => ({
        modelId: model.id,
        result: await adapter.probe(model.id),
      }));

      probed = results.length;
      usable = results.filter((r) => r.result.ok).length + (models.length - probed);

      /* Anything the budget did not reach has its verdict cleared rather than
         keeping the one from a previous run.
       *
         Without this a capped refresh is unable to undo itself: a model marked
         broken once — by a rate limit, an outage, or a bug in the probe — is
         never re-checked, because it falls outside the budget every time, and
         so stays excluded from routing permanently. An unknown verdict is
         honest and self-correcting; a stale one is neither. */
      const probedIds = new Set(results.map((r) => r.modelId));
      for (const model of models) {
        if (probedIds.has(model.id)) continue;
        await db
          .update(schema.models)
          .set({ probeOk: null, probeError: null })
          .where(and(eq(schema.models.providerId, row.id), eq(schema.models.modelId, model.id)));
      }

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

      /* Re-run the guess for anything still carrying a guess, so improvements
         to the classifier reach existing rows. Rows an admin has corrected are
         left alone — a refresh silently undoing a correction is exactly how a
         setting stops being trusted. */
      for (const model of models) {
        await db
          .update(schema.models)
          .set({ tier: inferTier(model.id) })
          .where(
            and(
              eq(schema.models.providerId, row.id),
              eq(schema.models.modelId, model.id),
              eq(schema.models.tierSource, "inferred"),
            ),
          );

        /* Same rule for prices, and for the same reason: a hand-set price is
           the real one, and a refresh must not overwrite it. Rows with no
           source at all predate the price table and are treated as guesses. */
        const priced = priceFor(model);
        await db
          .update(schema.models)
          .set(priced)
          .where(
            and(
              eq(schema.models.providerId, row.id),
              eq(schema.models.modelId, model.id),
              or(
                isNull(schema.models.priceSource),
                eq(schema.models.priceSource, "inferred"),
              ),
            ),
          );
      }
    }

    await db
      .update(schema.providerConnections)
      .set({ lastHealthAt: Date.now(), lastHealthOk: true })
      .where(eq(schema.providerConnections.id, row.id));

    return c.json({
      count: models.length,
      usable,
      probed,
      /* Stated rather than implied: a caller should know the difference between
         "verified working" and "listed but never tried". */
      unprobed: models.length - probed,
      /* Said out loud: a refresh that quietly drops models is worse than one
         that explains it, especially the first time a big catalogue shrinks. */
      removed,
      collapsed,
    });
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

/* How many models a refresh will verify before giving up on the rest. Chosen so
   an ordinary provider is fully checked while a gateway advertising hundreds
   does not turn a button press into five minutes and a rate limit. */
/* Several ids routinely point at one underlying model — "cc/claude-opus-5"
 * and "claude/claude-opus-5" are the same thing behind two prefixes, and on a
 * real gateway that is fifty-odd redundant entries cluttering every picker.
 * `root` is what the provider itself says they have in common, so it is the
 * honest basis for collapsing them.
 *
 * Not `parent`: that links an effort variant to its base ("-low", "-high"),
 * and those are genuinely different models someone picks between deliberately.
 * Collapsing on parent would throw away the choice.
 *
 * The alias is disabled rather than deleted, so it stays visible, keeps its
 * settings, and can be switched back on. Which one survives, in order:
 *
 *   1. One a model list or group already names. Those were chosen by hand, and
 *      disabling one would silently break a profile the router depends on.
 *   2. One already enabled, so a refresh does not move a working choice.
 *   3. One known to work.
 *   4. Shortest id, then alphabetical — arbitrary but stable, so repeated
 *      refreshes settle rather than flip-flopping. */
async function collapseAliases(
  providerId: string,
  offered: Array<{ id: string; root?: string }>,
): Promise<number> {
  const roots = new Map<string, string[]>();
  for (const model of offered) {
    if (!model.root) continue;
    roots.set(model.root, [...(roots.get(model.root) ?? []), model.id]);
  }

  const contested = [...roots.values()].filter((ids) => ids.length > 1);
  if (contested.length === 0) return 0;

  const rows = await db
    .select({ modelId: schema.models.modelId, enabled: schema.models.enabled, probeOk: schema.models.probeOk })
    .from(schema.models)
    .where(eq(schema.models.providerId, providerId));
  const state = new Map(rows.map((r) => [r.modelId, r]));

  /* Every model id any list or group names, whoever owns it: a model in use is
     not a duplicate to be tidied away. */
  const [listed, grouped] = await Promise.all([
    db.select({ modelId: schema.modelListEntries.modelId }).from(schema.modelListEntries),
    db.select({ modelId: schema.modelGroupMembers.modelId }).from(schema.modelGroupMembers),
  ]);
  const spokenFor = new Set(
    [...listed, ...grouped].map((r) => r.modelId).filter((id): id is string => Boolean(id)),
  );

  const rank = (id: string): number =>
    (spokenFor.has(id) ? 0 : 8) +
    (state.get(id)?.enabled ? 0 : 4) +
    (state.get(id)?.probeOk === true ? 0 : 2);

  let collapsed = 0;
  for (const ids of contested) {
    const [keep, ...aliases] = [...ids].sort(
      (a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b),
    );
    void keep;

    for (const alias of aliases) {
      /* Never silently drop one a list depends on, even as a runner-up. */
      if (spokenFor.has(alias) || state.get(alias)?.enabled === false) continue;
      await db
        .update(schema.models)
        .set({ enabled: false })
        .where(and(eq(schema.models.providerId, providerId), eq(schema.models.modelId, alias)));
      collapsed++;
    }
  }

  return collapsed;
}

const PROBE_LIMIT = 40;

/* Which models are worth the probe budget. The router prefers the tier a task
   needs and falls back upward, so the frontier models are the ones a capped
   run should verify; dated snapshots and obscure variants can wait until
   something actually asks for them. */
export function rankForProbing(modelId: string): number {
  const id = modelId.toLowerCase();
  if (/(opus|sonnet|gpt-5|gemini-3|haiku)/.test(id) && !/\d{8}$/.test(id)) return 0;
  if (/(opus|sonnet|gpt|gemini|haiku|llama|mistral|deepseek|qwen)/.test(id)) return 1;
  return 2;
}

/* Probing serially would take most of a minute even for a short list. Bounded
   concurrency keeps it quick without opening dozens of sockets at a rate
   limiter. */
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

/* Correcting a model's tier. The automatic guess is a starting point, not a
   verdict — names carry the signal inconsistently, and whoever pays the bill
   is better placed than a regular expression to say which models are worth
   spending on. */
providerRoutes.patch("/:id/models/:modelId", async (c) => {
  const actor = requireActor(c);
  const scope = await providerScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "provider.manage", scope);

  const parsed = z
    .object({
      tier: z.enum(["light", "standard", "heavy"]).optional(),
      enabled: z.boolean().optional(),
      /* Null clears a price back to unpriced. Zero is a real value — a model
         served from your own hardware genuinely costs nothing per token — so
         the two cannot be collapsed. */
      priceInPerMTok: z.number().min(0).max(10_000).nullable().optional(),
      priceOutPerMTok: z.number().min(0).max(10_000).nullable().optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Check the values.");

  const pricing =
    parsed.data.priceInPerMTok !== undefined || parsed.data.priceOutPerMTok !== undefined
      ? {
          ...(parsed.data.priceInPerMTok !== undefined
            ? { priceInPerMTok: parsed.data.priceInPerMTok }
            : {}),
          ...(parsed.data.priceOutPerMTok !== undefined
            ? { priceOutPerMTok: parsed.data.priceOutPerMTok }
            : {}),
          priceSource: "manual" as const,
        }
      : {};

  const updated = await db
    .update(schema.models)
    .set({
      ...(parsed.data.tier ? { tier: parsed.data.tier, tierSource: "manual" as const } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...pricing,
    })
    .where(
      and(
        eq(schema.models.providerId, c.req.param("id")),
        eq(schema.models.modelId, decodeURIComponent(c.req.param("modelId"))),
      ),
    )
    .returning({ id: schema.models.id });

  if (updated.length === 0) throw new NotFound();

  /* Recorded per field actually present, rather than one call that always
     says "tier_changed" — a bulk disable pass (turning off every "auto/" or
     "no-think/" variant a proxy re-publishes, say) would otherwise fill the
     audit log with entries claiming a tier change that never happened. */
  const modelId = c.req.param("modelId");
  if (parsed.data.tier) {
    await record(scope.ownerOrgId ?? null, actor, "model.tier_changed", modelId, {
      tier: parsed.data.tier,
    });
  }
  if (Object.keys(pricing).length) {
    await record(scope.ownerOrgId ?? null, actor, "model.price_changed", modelId, {
      priceIn: parsed.data.priceInPerMTok,
      priceOut: parsed.data.priceOutPerMTok,
    });
  }
  if (parsed.data.enabled !== undefined) {
    await record(
      scope.ownerOrgId ?? null,
      actor,
      parsed.data.enabled ? "model.enabled" : "model.disabled",
      modelId,
    );
  }

  return c.json({ ok: true });
});

/* Turn a whole upstream on or off in one go.
 *
 * A connection to a proxy is one row here but many providers behind it, and
 * they fail independently: when one loses its credentials, every model it
 * serves is dead while the rest of the connection is fine. Disabling them one
 * at a time is not a real option when there are twenty of them, and removing
 * the connection would take the working ones with it. */
const SetGroupEnabled = z.object({
  ownedBy: z.string().min(1),
  enabled: z.boolean(),
});

providerRoutes.patch("/:id/owners/:ownedBy", async (c) => {
  const actor = requireActor(c);
  const providerId = c.req.param("id");
  const scope = await providerScope(providerId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "provider.manage", scope);

  const parsed = SetGroupEnabled.safeParse({
    ownedBy: decodeURIComponent(c.req.param("ownedBy")),
    ...(await c.req.json().catch(() => ({}))),
  });
  if (!parsed.success) throw new BadRequest("Say whether to enable or disable it.");

  const changed = await db
    .update(schema.models)
    .set({ enabled: parsed.data.enabled })
    .where(
      and(
        eq(schema.models.providerId, providerId),
        eq(schema.models.ownedBy, parsed.data.ownedBy),
      ),
    )
    .returning({ id: schema.models.id });

  await record(
    scope.ownerOrgId ?? null,
    actor,
    parsed.data.enabled ? "provider.owner_enabled" : "provider.owner_disabled",
    providerId,
    { ownedBy: parsed.data.ownedBy, models: changed.length },
  );

  return c.json({ ok: true, models: changed.length });
});

/* Probe just one upstream's models.
 *
 * A refresh caps probing across the whole connection, so on a large gateway
 * most models never get checked — and the ones you actually care about are
 * usually the ones from the upstream you suspect. This is that question asked
 * narrowly: thirty calls to find out whether antigravity is back, rather than
 * three hundred to find out about everything.
 *
 * Not a refresh: it re-reads nothing and reconciles nothing, so testing an
 * upstream can never add or remove a model. It only records verdicts. */
providerRoutes.post("/:id/owners/:ownedBy/test", async (c) => {
  const actor = requireActor(c);
  const providerId = c.req.param("id");
  const ownedBy = decodeURIComponent(c.req.param("ownedBy"));

  const scope = await providerScope(providerId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "provider.manage", scope);

  const [row] = await db
    .select()
    .from(schema.providerConnections)
    .where(eq(schema.providerConnections.id, providerId))
    .limit(1);
  if (!row) throw new NotFound();

  const models = await db
    .select({ modelId: schema.models.modelId })
    .from(schema.models)
    .where(and(eq(schema.models.providerId, providerId), eq(schema.models.ownedBy, ownedBy)));

  if (models.length === 0) return c.json({ tested: 0, usable: 0 });

  const adapter = adapterFor(row);
  const results = await mapWithConcurrency(models, 6, async (model) => ({
    modelId: model.modelId,
    result: await adapter.probe(model.modelId),
  }));

  for (const { modelId, result } of results) {
    await db
      .update(schema.models)
      .set({
        probedAt: Date.now(),
        probeOk: result.ok,
        probeError: result.error ?? null,
        needsReasoningEffort: result.needsReasoningEffort ?? false,
      })
      .where(and(eq(schema.models.providerId, providerId), eq(schema.models.modelId, modelId)));
  }

  const usable = results.filter((r) => r.result.ok).length;
  await record(scope.ownerOrgId ?? null, actor, "provider.owner_tested", providerId, {
    ownedBy,
    tested: results.length,
    usable,
  });

  return c.json({ tested: results.length, usable });
});

/* Puts every model on this connection back to its automatic classification. */
providerRoutes.post("/:id/models/reclassify", async (c) => {
  const actor = requireActor(c);
  const scope = await providerScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "provider.manage", scope);

  const rows = await db
    .select({ modelId: schema.models.modelId })
    .from(schema.models)
    .where(eq(schema.models.providerId, c.req.param("id")));

  for (const row of rows) {
    const guess = inferPrice(row.modelId);
    await db
      .update(schema.models)
      .set({
        tier: inferTier(row.modelId),
        tierSource: "inferred",
        priceInPerMTok: guess?.inPerMTok ?? null,
        priceOutPerMTok: guess?.outPerMTok ?? null,
        priceSource: guess ? "inferred" : null,
      })
      .where(
        and(
          eq(schema.models.providerId, c.req.param("id")),
          eq(schema.models.modelId, row.modelId),
        ),
      );
  }

  await record(scope.ownerOrgId ?? null, actor, "model.tiers_reclassified", c.req.param("id"));
  return c.json({ reclassified: rows.length });
});

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
