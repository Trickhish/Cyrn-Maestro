import { bashStream } from "../lib/mock";
import type { LiveRun } from "../lib/useLiveRun";
import { Composer } from "../components/Composer";
import { StatusLine } from "../components/StatusLine";
import { ToolCalls } from "../components/ToolCalls";
import { DiffPanel } from "../components/DiffPanel";
import { PinIcon, HistoryIcon } from "../components/icons";

/* The core screen: one conversation with one agent. */

interface TaskThreadProps {
  live: LiveRun;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

export function TaskThread({ live, panelOpen, onTogglePanel }: TaskThreadProps) {
  const action = `re-running bun test src/auth · ${live.run}/${live.runs}`;

  return (
    <>
      <section className="flex-1 min-w-0 flex flex-col bg-canvas">
        <header className="h-[46px] flex-none flex items-center gap-3 px-[18px] border-b rule">
          <span className="text-[13px] text-tertiary">maestro-web</span>
          <span className="text-fainter">/</span>
          <h1 className="text-[13px] font-semibold">fix flaky auth test in CI</h1>
          <span className="pill pill-running">
            <span className="dot dot-running" />
            running
          </span>
          <span className="flex-1" />
          <span className="kbd">⌘K</span>
          <button
            type="button"
            className="w-[26px] h-[26px] rounded-md border rule-default grid place-items-center text-tertiary hover:text-primary"
            aria-label="Pin this task"
          >
            <PinIcon />
          </button>
          <button
            type="button"
            className="w-[26px] h-[26px] rounded-md border rule-default grid place-items-center text-tertiary hover:text-primary"
            aria-label="Toggle detail panel"
            onClick={onTogglePanel}
          >
            <HistoryIcon />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-auto scroll-quiet px-[26px] py-5 flex flex-col gap-[18px]">
          <div className="flex flex-col gap-1.5 max-w-[720px]">
            <div className="speaker">you · 14:02</div>
            <p className="text-[14px] leading-[1.65]">
              The auth test is flaky in CI. It passes locally every time. Find out why and
              fix it.
            </p>
          </div>

          <div className="flex flex-col gap-2 max-w-[720px]">
            <div className="flex items-center gap-2.5">
              <span className="speaker">agent · 14:02</span>
              {/* Provenance per turn: the router can switch either mid-task. */}
              <span className="font-mono text-[10px] text-plan">opus-5</span>
              <span className="font-mono text-[10px] text-faint">mac-studio-01</span>
            </div>
            <p className="prose-msg">
              Starting with the test itself, then the session helper it depends on.
              Flakiness that only shows in CI usually means a shared clock or a shared
              fixture.
            </p>
          </div>

          <ToolCalls />

          <p className="prose-msg max-w-[720px]">
            The expiry check compared a cached timestamp against a fresh one, so a slow CI
            runner could cross the boundary mid-test. It now takes the clock once,
            injected.
          </p>

          <div className="max-w-[720px] border rule rounded-lg overflow-hidden bg-inset">
            <div className="flex items-center gap-2.5 px-3 py-[7px] border-b rule font-mono text-[11px]">
              <span className="text-tertiary">Bash</span>
              <span className="text-secondary truncate">{bashStream.command}</span>
              <span className="flex-1" />
              <span className="text-accent-hi">streaming</span>
              <span className="text-faint tnum whitespace-nowrap">
                tail 6 of {live.streamedLines} lines
              </span>
            </div>
            <div className="px-3 py-2.5 font-mono text-[11.5px] leading-[1.7] text-tertiary overflow-x-auto scroll-quiet">
              {bashStream.tail.map((line) => (
                <div key={line} className="whitespace-nowrap">
                  {line}
                </div>
              ))}
              <div className="text-secondary whitespace-nowrap">
                run #{live.run} of {live.runs} — checking for flake
              </div>
              <div className="caret">▌</div>
            </div>
          </div>

          <p className="prose-msg max-w-[720px]">
            Running the suite twenty times to confirm it is actually stable
            <span className="caret">▌</span>
          </p>
        </div>

        <footer className="flex-none border-t rule bg-canvas">
          <StatusLine
            action={action}
            elapsed={live.elapsed}
            cost="$0.12"
            node="mac-studio-01"
            model="opus-5"
          />
          <div className="px-[18px] pt-3 pb-3.5">
            <Composer
              live
              placeholder="Steer it while it runs — it will pick this up on the next step"
              hints={[
                "⏎ send",
                "⇧⏎ newline",
                "⌘K palette",
                "⌘↵ send & interrupt",
                "⌘\\ toggle panel",
              ]}
            />
          </div>
        </footer>
      </section>

      {panelOpen && <DiffPanel onClose={onTogglePanel} />}
    </>
  );
}
