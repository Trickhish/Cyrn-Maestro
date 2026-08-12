import { isNull, eq, and } from "drizzle-orm";
import { db, schema } from "../db";
import { inferPrice } from "./pricing";

/* Filling in prices for models stored before there was a price table.
 *
 * Runs at boot because the alternative is worse: an existing instance would
 * keep recording $0 for every task, and its spend caps would keep silently not
 * working, until someone happened to press Refresh on each provider. A cap that
 * only starts working after an undocumented manual step is not a cap.
 *
 * Only rows with no price source are touched. A price from the provider is
 * authoritative and a price set by hand is deliberate; both carry a source, and
 * neither is overwritten here. */
export async function backfillModelPrices(): Promise<number> {
  const rows = await db
    .select({ id: schema.models.id, modelId: schema.models.modelId })
    .from(schema.models)
    .where(and(isNull(schema.models.priceSource), isNull(schema.models.priceInPerMTok)));

  let priced = 0;

  for (const row of rows) {
    const guess = inferPrice(row.modelId);
    /* A model the table does not recognise keeps a null source, so a later
       improvement to the table still reaches it. */
    if (!guess) continue;

    await db
      .update(schema.models)
      .set({
        priceInPerMTok: guess.inPerMTok,
        priceOutPerMTok: guess.outPerMTok,
        priceSource: "inferred",
      })
      .where(eq(schema.models.id, row.id));

    priced++;
  }

  return priced;
}
