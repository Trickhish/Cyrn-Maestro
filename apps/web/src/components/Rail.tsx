import { useState } from "react";
import { api, type Actor, type Project, type TaskSummary } from "../lib/api";
import { ConductorIcon, InboxIcon, FleetIcon, SettingsIcon, ThemeIcon } from "./icons";

/* The rail carries navigation, not counts.
 *
 * Each project shows one glyph for its worst state, so five projects and fifty
 * read the same. The only number here is the one that means "stop and look". */

export type View =
  | { name: "project"; projectId: string }
  | { name: "task"; taskId: string }
  | { name: "conductor" }
  | { name: "fleet" };

interface RailProps {
  actor: Actor;
  projects: Project[];
  tasks: TaskSummary[];
  view: View;
  onNavigate: (view: View) => void;
  onProjectCreated: (project: Project) => void;
  theme: string;
  onToggleTheme: () => void;
}

export function Rail({
  actor,
  projects,
  tasks,
  view,
  onNavigate,
  onProjectCreated,
  theme,
  onToggleTheme,
}: RailProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const needsYou = tasks.filter((t) => t.status === "awaiting_approval").length;

  /* Worst state wins: needs-you beats running beats idle. */
  function glyphFor(projectId: string): string {
    const mine = tasks.filter((t) => t.projectId === projectId);
    if (mine.some((t) => t.status === "awaiting_approval")) return "dot dot-needs";
    if (mine.some((t) => t.status === "running" || t.status === "queued")) return "dot dot-live";
    if (mine.some((t) => t.status === "failed")) return "dot dot-off";
    return "dot dot-idle";
  }

  function runningIn(projectId: string): number {
    return tasks.filter(
      (t) => t.projectId === projectId && !["completed", "failed", "cancelled"].includes(t.status),
    ).length;
  }

  return (
    <nav
      aria-label="Primary"
      className="w-[216px] flex-none bg-canvas-alt border-r rule flex flex-col py-3.5"
    >
      <div className="flex items-center gap-[9px] px-3.5 pb-4">
        <img src="/logo-mark-arcs.svg" alt="" width={22} height={22} className="block" />
        <span className="font-display text-[14px] font-semibold tracking-[-0.01em]">maestro</span>
      </div>

      <div className="flex flex-col gap-px px-2">
        <button
          type="button"
          className="rail-item"
          data-active={view.name === "conductor"}
          data-accent="true"
          onClick={() => onNavigate({ name: "conductor" })}
        >
          <ConductorIcon />
          <span className="flex-1">Conductor</span>
        </button>
        <button
          type="button"
          className="rail-item"
          onClick={() => {
            const first = tasks.find((t) => t.status === "awaiting_approval");
            if (first) onNavigate({ name: "task", taskId: first.id });
          }}
        >
          <InboxIcon />
          <span className="flex-1">Inbox</span>
          {needsYou > 0 && (
            <span className="font-mono text-[11px] text-on-accent bg-warn px-1.5 rounded-full tnum">
              {needsYou}
            </span>
          )}
        </button>
      </div>

      <div className="rail-label">projects</div>

      <div className="flex flex-col gap-px px-2">
        {projects.map((project) => {
          const running = runningIn(project.id);
          return (
            <button
              key={project.id}
              type="button"
              className="rail-item"
              data-active={view.name === "project" && view.projectId === project.id}
              onClick={() => onNavigate({ name: "project", projectId: project.id })}
            >
              <span className={glyphFor(project.id)} />
              <span className="flex-1 truncate">{project.name}</span>
              {running > 0 && (
                <span className="font-mono text-[11px] text-tertiary tnum">{running}</span>
              )}
            </button>
          );
        })}

        {creating ? (
          <form
            className="px-2 py-1.5"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return;
              const { project } = await api.createProject({ name: name.trim() });
              setName("");
              setCreating(false);
              onProjectCreated(project);
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => !name && setCreating(false)}
              placeholder="Project name"
              className="w-full bg-surface border rule-default rounded px-2 py-1 text-[12.5px] outline-none focus:border-[var(--border-accent)]"
            />
          </form>
        ) : (
          <button
            type="button"
            className="px-2 py-1.5 text-[12px] text-faint hover:text-secondary text-left"
            onClick={() => setCreating(true)}
          >
            + New project
          </button>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex flex-col gap-px px-2 pt-2.5 mt-2.5 border-t rule">
        <button
          type="button"
          className="rail-item"
          data-active={view.name === "fleet"}
          onClick={() => onNavigate({ name: "fleet" })}
        >
          <FleetIcon />
          <span className="flex-1">Fleet</span>
        </button>
        <button type="button" className="rail-item" onClick={onToggleTheme} title="Toggle theme">
          <ThemeIcon />
          <span className="flex-1">Theme</span>
          <span className="font-mono text-[11px] text-faint">{theme}</span>
        </button>
        <button
          type="button"
          className="rail-item"
          onClick={() => api.logout().then(() => location.reload())}
        >
          <SettingsIcon />
          <span className="flex-1 truncate">{actor.email}</span>
        </button>
      </div>
    </nav>
  );
}
