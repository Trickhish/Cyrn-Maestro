import type { ProviderModel } from "../lib/api";

/* Whether a spend cap can actually be enforced.
 *
 * A cap is only as good as the prices behind it: a model with no price records
 * no cost, so tasks on it accrue nothing and run straight past the cap. That
 * failure is invisible — the number sits there looking like protection — so it
 * is stated next to the field rather than left to be discovered from a bill.
 *
 * Only usable models count. A model that failed its probe cannot be routed to,
 * so its missing price is not a hole in the cap. */
export function CapCoverage({ models, capSet }: { models: ProviderModel[]; capSet: boolean }) {
  const usable = models.filter((m) => m.probeOk !== false);
  if (usable.length === 0) return null;

  const unpriced = usable.filter((m) => m.priceInPerMTok == null && m.priceOutPerMTok == null);
  if (unpriced.length === 0) return null;

  const all = unpriced.length === usable.length;

  return (
    <div
      className={`text-[11.5px] leading-snug ${capSet ? "text-warn-hi" : "text-faint"}`}
      role={capSet ? "status" : undefined}
    >
      {all
        ? "None of the usable models have a price, so tasks record no cost and a cap here cannot stop anything."
        : `${unpriced.length} of ${usable.length} usable models have no price. Tasks on those record no cost, so they do not count towards a cap.`}{" "}
      Set prices under Connections → Providers.
    </div>
  );
}
