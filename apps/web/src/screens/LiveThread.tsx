import { useEffect, useRef, useState } from "react";
import { useNarrow } from "../lib/useNarrow";
import { api, type TaskStatus } from "../lib/api";
import { useTaskStream, type ThreadItem, type ToolEntry } from "../lib/useTaskStream";
import { Composer } from "../components/Composer";

/* The task thread, driven by the real event log.
 *
 * Same shell as the approved design: collapsed tool calls, a live status line,
 * inline approvals, a composer that stays alive while the agent works. */

const TERMINAL: TaskStatus[] = ["completed", "failed", "cancelled"];

export function LiveThread({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const live = useTaskStream(taskId);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  /* Follow the tail while the user is at the bottom, but never yank the view
     back down if they have scrolled up to read something. */
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [live.items.length, live.currentAction]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  const running = !TERMINAL.includes(live.status);
  const narrow = useNarrow();

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-canvas">
      <header className="h-[46px] flex-none flex items-center gap-3 px-4 md:px-[18px] border-b rule overflow-x-auto scroll-quiet">
        <button type="button" className="text-[13px] text-tertiary hover:text-primary" onClick={onBack}>
          {live.task?.projectName ?? "project"}
        </button>
        <span className="text-fainter">/</span>
        <h1 className="text-[13px] font-semibold truncate min-w-0">{live.task?.title ?? "…"}</h1>
        <StatusPill status={live.status} />
        <span className="flex-1" />
        {live.model && (
          <span className="hidden sm:inline font-mono text-[10px] text-plan whitespace-nowrap">{live.model}</span>
        )}
        {live.nodeName && (
          <span className="hidden sm:inline font-mono text-[10px] text-faint whitespace-nowrap">{live.nodeName}</span>
        )}
      </header>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-auto scroll-quiet px-4 md:px-[26px] py-5 flex flex-col gap-[18px]"
      >
        {live.items.map((item, i) => (
          <Item key={`${item.kind}-${item.seq}-${i}`} item={item} taskId={taskId} />
        ))}

        {live.items.length === 0 && (
          <div className="text-[13px] text-faint">Waiting for the first event…</div>
        )}
      </div>

      <footer className="flex-none border-t rule bg-canvas">
        {running && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 md:px-[18px] py-2 font-mono text-[11px] border-b rule">
            <span className="flex items-center gap-[7px] text-accent-hi">
              <span className="dot dot-running" />
              <span>{live.status === "awaiting_approval" ? "needs you" : "running"}</span>
            </span>
            <span className="text-secondary truncate">
              {live.status === "awaiting_approval"
                ? (live.pendingApproval?.summary ?? "waiting for approval")
                : (live.currentAction ?? "thinking")}
            </span>
            <span className="text-fainter">·</span>
            <span className="text-tertiary tnum">
              {live.tokens.input.toLocaleString()} in / {live.tokens.output.toLocaleString()} out
            </span>
            {live.cost > 0 && (
              <>
                <span className="text-fainter">·</span>
                <span className="text-tertiary tnum">${live.cost.toFixed(4)}</span>
              </>
            )}
            <span className="flex-1" />
            <button
              type="button"
              className="btn btn-chip"
              onClick={() => api.cancelTask(taskId).catch(() => {})}
            >
              Stop
            </button>
          </div>
        )}

        <div className="px-4 md:px-[18px] pt-3 pb-3.5">
          <Composer
            live={running}
            placeholder={
              running
                ? narrow
                  ? "Steer it…"
                  : "Steer it while it runs — it will pick this up on the next step"
                : "This task has finished."
            }
            hints={["⏎ send", "⇧⏎ newline", "⌘K palette", "⌘\\ toggle panel"]}
            onSend={(text) => {
              api.steer(taskId, text).catch(() => {});
            }}
          />
        </div>
      </footer>
    </section>
  );
}

function Item({ item, taskId }: { item: ThreadItem; taskId: string }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex flex-col gap-1.5 max-w-[720px]">
          <div className="speaker">
            you{item.queued ? " · queued mid-run" : ""}
          </div>
          <p className="text-[14px] leading-[1.65] whitespace-pre-wrap">{item.text}</p>
        </div>
      );

    case "assistant":
      return (
        <div className="flex flex-col gap-2 max-w-[720px]">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="speaker">agent</span>
            {item.model && <span className="font-mono text-[10px] text-plan">{item.model}</span>}
          </div>
          <p className="prose-msg whitespace-pre-wrap">
            {item.text}
            {item.streaming && <span className="caret">▌</span>}
          </p>
        </div>
      );

    case "tools":
      return (
        <div className="flex flex-col gap-px max-w-[720px] border-l rule pl-3.5">
          {item.entries.map((entry) => (
            <ToolRow key={entry.callId} entry={entry} taskId={taskId} />
          ))}
        </div>
      );

    case "note":
      return (
        <div
          className={`max-w-[720px] text-[13px] border rounded-lg px-3 py-2 ${
            item.tone === "bad"
              ? "border-[var(--border-warn)] text-bad-hi"
              : "rule text-tertiary"
          }`}
        >
          {item.text}
        </div>
      );
  }
}

function ToolRow({ entry, taskId }: { entry: ToolEntry; taskId: string }) {
  const [open, setOpen] = useState(false);
  const pending = entry.approval && !entry.approval.decided;
  const body = entry.logs || entry.result?.output;

  return (
    <div>
      <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="text-faint w-2.5 flex-none">{open ? "▾" : "▸"}</span>
        <span className="text-tertiary w-[68px] flex-none">{entry.tool}</span>
        <span className="text-secondary truncate">{entry.summary}</span>
        <span className="flex-1" />
        {!entry.result && !pending && <span className="text-accent-hi flex-none">running</span>}
        {entry.result && (
          <span className={`flex-none ${entry.result.ok ? "text-faint" : "text-bad"}`}>
            {entry.result.ok ? "ok" : `exit ${entry.result.exitCode ?? 1}`}
          </span>
        )}
        {entry.result?.durationMs !== undefined && (
          <span className="text-faint flex-none tnum">{entry.result.durationMs}ms</span>
        )}
      </button>

      {/* Approvals land where the call happened, not in a modal. */}
      {pending && (
        <div className="ml-[46px] my-1.5 border border-[var(--border-warn)] bg-raised rounded-lg px-3 py-2.5 flex flex-col gap-2">
          <div className="text-[12.5px] text-secondary">
            This node's policy wants your approval before running it.
          </div>
          <div className="font-mono text-[11.5px] text-tertiary bg-inset border rule rounded px-2 py-1.5 overflow-x-auto scroll-quiet whitespace-nowrap">
            {entry.summary}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-sm btn-warn"
              onClick={() => api.approve(taskId, entry.callId, true).catch(() => {})}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => api.approve(taskId, entry.callId, false).catch(() => {})}
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {entry.approval?.decided && (
        <div className="ml-[46px] mb-1 text-[12px] text-faint">
          {entry.approval.approved ? "Approved" : "Denied"}
        </div>
      )}

      {open && body && (
        <pre className="ml-[46px] my-1 px-3 py-2 bg-inset border rule rounded-md font-mono text-[11.5px] leading-[1.7] text-tertiary whitespace-pre-wrap overflow-x-auto scroll-quiet max-h-[380px]">
          {body}
          {entry.result?.truncated ? "\n\n… output clipped …" : ""}
        </pre>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: TaskStatus }) {
  if (status === "awaiting_approval") {
    return (
      <span className="pill pill-needs">
        <span className="dot dot-needs" />
        needs you
      </span>
    );
  }
  if (TERMINAL.includes(status)) {
    return (
      <span className="pill" style={{ color: "var(--color-faint)" }}>
        {status}
      </span>
    );
  }
  return (
    <span className="pill pill-running">
      <span className="dot dot-running" />
      {status}
    </span>
  );
}
