import { useState } from "react";
import { changedFiles, diff } from "../lib/mock";

/* The detail panel: what the agent did, as opposed to what it said. */

const tabs = ["Diff", "Terminal", "Files"] as const;
type Tab = (typeof tabs)[number];

export function DiffPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("Diff");
  const [file, setFile] = useState(changedFiles[0].path);

  const totalAdded = changedFiles.reduce((n, f) => n + f.added, 0);
  const totalRemoved = changedFiles.reduce((n, f) => n + f.removed, 0);

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

      <div className="flex-none px-3 py-2.5 border-b rule flex flex-col gap-1.5">
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span className="text-secondary">{changedFiles.length} files</span>
          <span className="text-add tnum">+{totalAdded}</span>
          <span className="text-bad tnum">−{totalRemoved}</span>
          <span className="flex-1" />
          <span className="text-faint">this task</span>
        </div>
        <div className="flex flex-col gap-px font-mono text-[11px]">
          {changedFiles.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => setFile(f.path)}
              className={`flex gap-2 px-1.5 py-[3px] rounded text-left ${
                file === f.path ? "bg-hover text-primary" : "text-secondary hover:bg-raised"
              }`}
            >
              <span className="flex-1 truncate">{f.path}</span>
              <span className="text-add tnum">+{f.added}</span>
              <span className="text-bad tnum">−{f.removed}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-quiet">
        {tab === "Diff" &&
          diff.map((row, i) =>
            row.kind === "hunk" ? (
              <div key={i} className="diff-hunk border-y rule">
                {row.text}
              </div>
            ) : (
              <div key={i} className={`diff-line diff-${row.kind}`}>
                <span className="diff-num">{row.num}</span>
                <span className="diff-text whitespace-pre">{row.text}</span>
              </div>
            ),
          )}

        {tab === "Terminal" && (
          <div className="p-3 font-mono text-[11.5px] leading-[1.7] text-tertiary">
            <div>$ bun test src/auth</div>
            <div>bun test v1.3.14</div>
            <div className="text-secondary">24 pass, 0 fail — run 3 of 20</div>
            <div className="caret">▌</div>
          </div>
        )}

        {tab === "Files" && (
          <div className="p-3 font-mono text-[11.5px] leading-[1.9] text-tertiary">
            <div className="text-secondary">src/auth/</div>
            {["session.ts", "clock.ts", "index.ts", "__tests__/session.test.ts"].map((f) => (
              <div key={f} className="pl-3">
                {f}
              </div>
            ))}
          </div>
        )}

        {tab === "Diff" && (
          <div className="diff-line pt-1.5">
            <span className="diff-num" />
            <span className="text-faint">still writing — 1 hunk pending</span>
          </div>
        )}
      </div>

      <div className="flex-none border-t rule px-3 py-[11px] flex items-center gap-2">
        <button type="button" className="btn btn-primary">
          Review changes
        </button>
        <button type="button" className="btn">
          Open in editor
        </button>
        <span className="flex-1" />
        <span className="hint">⌥↑↓ hunk</span>
      </div>
    </aside>
  );
}
