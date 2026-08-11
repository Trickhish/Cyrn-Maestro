import { useState } from "react";
import { toolCalls } from "../lib/mock";

/* Tool calls are one-line summaries that expand. A thread has to stay readable
   after two hundred of these, so the collapsed row is the default state and the
   result lives behind a disclosure. */

export function ToolCalls() {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-px max-w-[720px] border-l rule pl-3.5">
      {toolCalls.map((call) => {
        const isOpen = open === call.id;
        return (
          <div key={call.id}>
            <button
              type="button"
              className="tool-row"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : call.id)}
            >
              <span className="text-faint w-2.5 flex-none">{isOpen ? "▾" : "▸"}</span>
              <span className="text-tertiary w-9 flex-none">{call.name}</span>
              <span className="text-secondary truncate">{call.target}</span>
              <span className="flex-1" />
              {call.meta && <span className="text-faint flex-none">{call.meta}</span>}
              {call.added !== undefined && (
                <span className="text-add flex-none tnum">+{call.added}</span>
              )}
              {call.removed !== undefined && (
                <span className="text-bad flex-none tnum">−{call.removed}</span>
              )}
            </button>
            {isOpen && call.detail && (
              <div className="ml-[46px] my-1 px-3 py-2 bg-inset border rule rounded-md font-mono text-[11.5px] leading-[1.7] text-tertiary whitespace-pre-wrap">
                {call.detail.join("\n")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
