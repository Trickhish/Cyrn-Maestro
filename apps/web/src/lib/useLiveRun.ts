import { useEffect, useState } from "react";

/* A running task is the only thing on screen that changes by itself, so the
   demo advances two numbers on a timer: the wall clock and the flake-check
   counter. Everything else is static fixture data. Kept in one hook so there is
   exactly one interval for the whole app, and so it is obvious what to delete
   once real events arrive over the socket. */

export interface LiveRun {
  elapsed: string;
  run: number;
  runs: number;
  streamedLines: number;
}

const START_SECONDS = 4 * 60 + 41;

function format(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function useLiveRun(active: boolean): LiveRun {
  const [seconds, setSeconds] = useState(START_SECONDS);

  useEffect(() => {
    if (!active) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (media.matches) return;
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const ticks = seconds - START_SECONDS;
  const run = Math.min(20, 3 + Math.floor(ticks / 6));

  return {
    elapsed: format(seconds),
    run,
    runs: 20,
    streamedLines: 214 + ticks * 3,
  };
}
