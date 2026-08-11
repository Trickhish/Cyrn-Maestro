import { useState } from "react";
import { needsYouTask, runningTask } from "../lib/mock";

/* A live task card carries one line of current action, not a log — the tail of
   what it is doing plus a thin progress rule. It never grows; it updates in
   place, so six of them stay a fixed block of the conversation instead of
   turning the Conductor into a scrolling feed of six agents at once. */

export function NeedsYouCard({ onOpen }: { onOpen: () => void }) {
  const [decision, setDecision] = useState<"approved" | "denied" | null>(null);

  return (
    <div className="border border-[var(--border-warn)] bg-raised rounded-[10px] px-[13px] py-[11px] flex flex-col gap-2">
      <div className="flex items-center gap-[9px]">
        <span className="dot dot-lg dot-needs" />
        <span className="text-[13px] font-semibold">{needsYouTask.title}</span>
        <span className="font-mono text-[10px] text-tertiary">{needsYouTask.project}</span>
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-warn-hi">{needsYouTask.waiting}</span>
      </div>

      <div className="font-mono text-[11.5px] text-tertiary bg-inset border rule rounded-md px-[9px] py-[7px] overflow-x-auto scroll-quiet whitespace-nowrap">
        wants to run: {needsYouTask.command}
      </div>

      {decision ? (
        <div className="flex items-center gap-2 text-[12px]">
          <span className={decision === "approved" ? "text-accent-hi" : "text-bad-hi"}>
            {decision === "approved" ? "Approved" : "Denied"}
          </span>
          <span className="text-faint">— the agent picks this up on its next step</span>
          <span className="flex-1" />
          <button type="button" className="text-[12px] text-accent-hi" onClick={onOpen}>
            Open thread ↗
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-sm btn-warn"
            onClick={() => setDecision("approved")}
          >
            Approve
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setDecision("denied")}
          >
            Deny
          </button>
          <span className="flex-1" />
          <button type="button" className="text-[12px] text-accent-hi" onClick={onOpen}>
            Open thread ↗
          </button>
        </div>
      )}
    </div>
  );
}

interface RunningCardProps {
  action: string;
  elapsed: string;
  progress: number;
  onOpen: () => void;
}

export function RunningCard({ action, elapsed, progress, onOpen }: RunningCardProps) {
  return (
    <div className="border rule bg-raised rounded-[10px] px-[13px] py-[11px] flex flex-col gap-2">
      <div className="flex items-center gap-[9px]">
        <span className="dot dot-lg dot-live" />
        <span className="text-[13px] font-semibold">{runningTask.title}</span>
        <span className="font-mono text-[10px] text-tertiary">{runningTask.project}</span>
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-tertiary tnum">
          {elapsed} · {runningTask.cost} · {runningTask.model}
        </span>
      </div>

      <div className="flex items-center gap-2.5 font-mono text-[11.5px]">
        <span className="text-accent-hi">▶</span>
        <span className="text-tertiary truncate">{action}</span>
        <span className="flex-1" />
        <span className="text-add tnum">+{runningTask.added}</span>
        <span className="text-bad tnum">−{runningTask.removed}</span>
      </div>

      <div className="meter">
        <div className="meter-fill" style={{ width: `${progress}%` }} />
      </div>

      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] text-faint">{runningTask.node}</span>
        <span className="flex-1" />
        <button type="button" className="text-[12px] text-accent-hi" onClick={onOpen}>
          Open thread ↗
        </button>
      </div>
    </div>
  );
}

export function QuietRuns() {
  const [shown, setShown] = useState(false);

  if (shown) {
    return (
      <div className="flex flex-col gap-1">
        {[
          ["Port the settings page to tokens", "design-tokens", "editing Appearance.tsx"],
          ["Upgrade bun to 1.2", "billing-svc", "reading lockfile"],
          ["Backfill the events table", "auster-api", "running migration 004"],
          ["Regenerate API types", "maestro-web", "writing client.d.ts"],
        ].map(([title, project, action]) => (
          <div
            key={title}
            className="flex items-center gap-2.5 px-1 py-1 text-[12.5px] text-secondary"
          >
            <span className="dot dot-running" />
            <span className="w-[220px] truncate">{title}</span>
            <span className="font-mono text-[10.5px] text-faint w-[92px] truncate">
              {project}
            </span>
            <span className="font-mono text-[11px] text-tertiary truncate flex-1">
              {action}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 px-1 py-0.5">
      <span className="text-[12.5px] text-tertiary">4 more running quietly</span>
      <span className="flex gap-1">
        <span className="dot dot-running" />
        <span className="dot dot-running" />
        <span className="dot dot-running" />
      </span>
      <button
        type="button"
        className="text-[12.5px] text-accent-hi"
        onClick={() => setShown(true)}
      >
        Show
      </button>
    </div>
  );
}
