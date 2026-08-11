import { projects, moreProjects, fleet, type TaskState } from "../lib/mock";
import type { View } from "../lib/view";
import {
  ConductorIcon,
  InboxIcon,
  FleetIcon,
  ProvidersIcon,
  SettingsIcon,
  ThemeIcon,
} from "./icons";

/* The rail carries navigation, not counts.
   Each project shows one glyph for its worst state, so five projects and fifty
   read the same. Inbox is the only number here, because it is the only one that
   means "stop and look". */

const dotClass: Record<TaskState, string> = {
  running: "dot dot-running",
  "needs-you": "dot dot-needs",
  idle: "dot dot-idle",
  done: "dot dot-done",
  offline: "dot dot-off",
};

interface RailProps {
  view: View;
  onNavigate: (view: View) => void;
  inbox: number;
  theme: string;
  onToggleTheme: () => void;
}

export function Rail({ view, onNavigate, inbox, theme, onToggleTheme }: RailProps) {
  return (
    <nav
      aria-label="Primary"
      className="w-[216px] flex-none bg-canvas-alt border-r rule flex flex-col py-3.5"
    >
      <div className="flex items-center gap-[9px] px-3.5 pb-4">
        <img
          src="/logo-mark-arcs.svg"
          alt=""
          width={22}
          height={22}
          className="block w-[22px] h-[22px]"
        />
        <span className="font-display text-[14px] font-semibold tracking-[-0.01em]">
          maestro
        </span>
      </div>

      <div className="flex flex-col gap-px px-2">
        <button
          type="button"
          className="rail-item"
          data-active={view === "conductor"}
          data-accent="true"
          onClick={() => onNavigate("conductor")}
        >
          <ConductorIcon />
          <span className="flex-1">Conductor</span>
        </button>
        <button type="button" className="rail-item" onClick={() => onNavigate("conductor")}>
          <InboxIcon />
          <span className="flex-1">Inbox</span>
          <span className="font-mono text-[11px] text-on-accent bg-warn px-1.5 rounded-full tnum">
            {inbox}
          </span>
        </button>
      </div>

      <div className="rail-label">projects</div>

      <div className="flex flex-col gap-px px-2">
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            className="rail-item"
            data-active={view === "thread" && p.id === "maestro-web"}
            onClick={() => onNavigate("thread")}
          >
            <span
              className={
                p.id === "maestro-web" && view === "thread"
                  ? "dot dot-live"
                  : dotClass[p.state]
              }
            />
            <span className="flex-1 truncate">{p.name}</span>
            {p.running ? (
              <span className="font-mono text-[11px] text-tertiary tnum">{p.running}</span>
            ) : null}
          </button>
        ))}
        <div className="px-2 py-1.5 text-[12px] text-faint">+ {moreProjects} more</div>
      </div>

      <div className="flex-1" />

      <div className="flex flex-col gap-px px-2 pt-2.5 mt-2.5 border-t rule">
        <button type="button" className="rail-item">
          <FleetIcon />
          <span className="flex-1">Fleet</span>
          <span className="font-mono text-[11px] text-faint tnum">
            {fleet.online}/{fleet.total}
          </span>
        </button>
        <button type="button" className="rail-item">
          <ProvidersIcon />
          <span className="flex-1">Providers</span>
        </button>
        <button type="button" className="rail-item">
          <SettingsIcon />
          <span className="flex-1">Settings</span>
        </button>
        <button
          type="button"
          className="rail-item"
          onClick={onToggleTheme}
          title="Toggle theme"
        >
          <ThemeIcon />
          <span className="flex-1">Theme</span>
          <span className="font-mono text-[11px] text-faint">{theme}</span>
        </button>
      </div>
    </nav>
  );
}
