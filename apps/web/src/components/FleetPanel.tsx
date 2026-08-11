import { useState } from "react";
import { fleet, machines } from "../lib/mock";

/* The Conductor's detail panel. Load is a meter rather than a number alone, so
   a saturated box reads at a glance; the router's pick is the only card that
   gets an accent border, because it is the only one the pending plan depends on. */

const tabs = ["Fleet", "Spend"] as const;
type Tab = (typeof tabs)[number];

export function FleetPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("Fleet");

  return (
    <aside className="w-[392px] flex-none bg-surface border-l rule flex flex-col">
      <div className="h-[46px] flex-none flex items-center gap-0.5 px-2.5 border-b rule">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            className="tab"
            data-active={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" className="hint" onClick={onClose} title="Toggle panel">
          ⌘\
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-quiet p-3 flex flex-col gap-1.5">
        {tab === "Fleet" ? (
          <>
            {machines.map((m) => (
              <div
                key={m.name}
                className={`flex flex-col gap-1.5 border rounded-lg px-[11px] py-2.5 ${
                  m.routerPick
                    ? "border-[var(--border-accent)] bg-raised"
                    : m.state === "offline"
                      ? "rule"
                      : "rule bg-raised"
                }`}
              >
                <div className="flex items-center gap-2 font-mono text-[11.5px]">
                  <span
                    className={`dot ${
                      m.state === "offline"
                        ? "dot-off"
                        : m.state === "idle"
                          ? "dot-idle"
                          : "dot-running"
                    }`}
                  />
                  <span
                    className={`flex-1 ${m.state === "offline" ? "text-secondary" : "text-primary"}`}
                  >
                    {m.name}
                  </span>
                  {m.tasks && <span className="text-tertiary">{m.tasks}</span>}
                  {m.note && (
                    <span className={m.routerPick ? "text-accent-hi" : "text-bad-hi"}>
                      {m.note}
                    </span>
                  )}
                </div>
                {m.load !== undefined && (
                  <div className="meter">
                    <div
                      className="meter-fill"
                      data-hot={m.load >= 80}
                      style={{ width: `${m.load}%` }}
                    />
                  </div>
                )}
                {m.spec && (
                  <div className="font-mono text-[10.5px] text-faint">{m.spec}</div>
                )}
              </div>
            ))}
            <div className="px-1 py-1.5 font-mono text-[11px] text-faint">
              + {fleet.idleHidden} idle machines
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2 font-mono text-[11.5px]">
            {[
              ["maestro-web", "$1.84"],
              ["auster-api", "$1.02"],
              ["design-tokens", "$0.71"],
              ["infra", "$0.61"],
            ].map(([project, amount]) => (
              <div
                key={project}
                className="flex items-center gap-2 border rule rounded-lg px-[11px] py-2.5 bg-raised"
              >
                <span className="flex-1 text-primary">{project}</span>
                <span className="text-tertiary tnum">{amount}</span>
              </div>
            ))}
            <div className="px-1 py-1.5 text-[11px] text-faint">
              billed to acme · today
            </div>
          </div>
        )}
      </div>

      <div className="flex-none border-t rule px-3 py-[11px] flex items-center gap-2.5 font-mono text-[11px] text-tertiary">
        <span>
          {fleet.online} of {fleet.total} online
        </span>
        <span className="text-fainter">·</span>
        <span className="tnum">{fleet.spendToday} today</span>
        <span className="flex-1" />
        <button type="button" className="text-accent-hi">
          Fleet ↗
        </button>
      </div>
    </aside>
  );
}
