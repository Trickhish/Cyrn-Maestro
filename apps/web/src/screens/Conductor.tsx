import { fleet } from "../lib/mock";
import type { LiveRun } from "../lib/useLiveRun";
import { Composer } from "../components/Composer";
import { FleetPanel } from "../components/FleetPanel";
import { RouterPlan } from "../components/RouterPlan";
import { NeedsYouCard, RunningCard, QuietRuns } from "../components/TaskCards";

/* The conversation about all of them. Milestones and live cards only — never
   six agents' raw tool calls interleaved into one feed. */

interface ConductorProps {
  live: LiveRun;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenThread: () => void;
}

export function Conductor({
  live,
  panelOpen,
  onTogglePanel,
  onOpenThread,
}: ConductorProps) {
  const action = `re-running bun test src/auth · ${live.run}/${live.runs}`;

  return (
    <>
      <section className="flex-1 min-w-0 flex flex-col bg-canvas">
        <header className="h-[46px] flex-none flex items-center gap-3 px-[18px] border-b rule">
          <h1 className="font-display text-[14px] font-semibold">Conductor</h1>
          <span className="text-[12.5px] text-tertiary">
            the conversation about everything
          </span>
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-tertiary tnum">
            6 running · 3 need you · {fleet.spendToday} today
          </span>
        </header>

        <div className="flex-1 min-h-0 overflow-auto scroll-quiet px-[26px] py-5 flex flex-col gap-[18px]">
          <div className="flex flex-col gap-1.5 max-w-[760px]">
            <div className="speaker">you · 14:06</div>
            <p className="text-[14px] leading-[1.65]">What's running?</p>
          </div>

          <div className="flex flex-col gap-3 max-w-[760px]">
            <div className="speaker">conductor · 14:06</div>
            <p className="prose-msg">
              Six tasks. One has been waiting on you for nine minutes.
            </p>

            <div className="flex flex-col gap-1.5">
              <NeedsYouCard onOpen={onOpenThread} />
              <RunningCard
                action={action}
                elapsed={live.elapsed}
                progress={(live.run / live.runs) * 100}
                onOpen={onOpenThread}
              />
              <QuietRuns />
            </div>
          </div>

          <div className="flex flex-col gap-1.5 max-w-[760px]">
            <div className="speaker">you · 14:09</div>
            <p className="text-[14px] leading-[1.65]">
              Run the pending migration on infra, whichever box is free.
            </p>
          </div>

          <div className="flex flex-col gap-2.5 max-w-[760px]">
            <div className="speaker">conductor · 14:09</div>
            <p className="prose-msg">
              This one reaches production data, so I am showing you the plan first.
            </p>
            <RouterPlan />
          </div>
        </div>

        <footer className="flex-none border-t rule px-[26px] pt-3 pb-3.5">
          <Composer
            chip="any project"
            placeholder="Ask about everything, or describe a task to dispatch"
            hints={["⌘K palette", "⌘1-9 jump to task", "⌘I inbox", "⌘\\ side panel"]}
          />
        </footer>
      </section>

      {panelOpen && <FleetPanel onClose={onTogglePanel} />}
    </>
  );
}
