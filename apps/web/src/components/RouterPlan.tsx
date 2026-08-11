import { useState } from "react";
import { routerPlan } from "../lib/mock";

/* The router shows its work before it acts, not after. Nothing has run when
   this renders — the "because" column is the whole point, and every alternative
   is one click to override. */

export function RouterPlan() {
  const [dispatched, setDispatched] = useState(false);
  const [picks, setPicks] = useState<Record<string, string>>({});

  return (
    <div className="border border-[var(--border-plan)] bg-raised rounded-[10px] overflow-hidden">
      <div className="flex items-center gap-[9px] px-[13px] py-[9px] border-b rule">
        <span className="w-[7px] h-[7px] rounded-sm bg-plan flex-none" />
        <span className="text-[12.5px] font-semibold">Router plan</span>
        <span className="font-mono text-[10.5px] text-tertiary">
          {dispatched ? "dispatched" : "not dispatched"}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-faint tnum">est. $0.30 · ~6m</span>
      </div>

      <div className="overflow-x-auto scroll-quiet">
        <div className="grid grid-cols-[80px_1fr_1fr_1fr] gap-px bg-[var(--border-subtle)] min-w-[620px]">
          {["choice", "picked", "because", "alternatives"].map((h) => (
            <div
              key={h}
              className="bg-raised px-[13px] py-[9px] font-mono text-[10px] tracking-[0.1em] uppercase text-faint"
            >
              {h}
            </div>
          ))}

          {routerPlan.map((row) => (
            <Row
              key={row.choice}
              row={row}
              override={picks[row.choice]}
              onOverride={(value) =>
                setPicks((p) => ({ ...p, [row.choice]: value }))
              }
              locked={dispatched}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-[9px] px-[13px] py-[11px] border-t rule">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setDispatched(true)}
          disabled={dispatched}
        >
          {dispatched ? "Dispatched" : "Dispatch"}
        </button>
        <button type="button" className="btn">
          Edit plan
        </button>
        <span className="flex-1" />
        <span className="hint">⏎ dispatch · ⌘⏎ dispatch &amp; open</span>
      </div>
    </div>
  );
}

interface RowProps {
  row: (typeof routerPlan)[number];
  override?: string;
  onOverride: (value: string) => void;
  locked: boolean;
}

function Row({ row, override, onOverride, locked }: RowProps) {
  const alternatives = row.alternatives === "—" ? [] : row.alternatives.split(" · ");
  const picked = override ?? row.picked;
  // Once you override, the original choice becomes the alternative you can go back to.
  const options = alternatives
    .concat(override ? [row.picked] : [])
    .filter((a) => a !== picked);

  return (
    <>
      <div className="bg-surface px-[13px] py-2.5 text-[12.5px] text-secondary">
        {row.choice}
      </div>
      <div className="bg-surface px-[13px] py-2.5 font-mono text-[12px] text-primary">
        {picked}
        {override && <span className="text-accent-hi"> ·  yours</span>}
      </div>
      <div className="bg-surface px-[13px] py-2.5 text-[12px] text-secondary">
        {override ? "You overrode the router" : row.because}
      </div>
      <div className="bg-surface px-[13px] py-2.5 font-mono text-[12px] flex flex-wrap gap-x-2 gap-y-1">
        {options.length === 0 ? (
          <span className="text-tertiary">—</span>
        ) : (
          options.map((alt) => (
            <button
              key={alt}
              type="button"
              className="text-accent-hi hover:underline disabled:no-underline disabled:text-faint"
              onClick={() => onOverride(alt)}
              disabled={locked}
            >
              {alt}
            </button>
          ))
        )}
      </div>
    </>
  );
}
