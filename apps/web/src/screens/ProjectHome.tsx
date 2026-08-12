import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type NodeSummary,
  type Project,
  type Provider,
  type TaskStatus,
  type TaskSummary,
} from "../lib/api";
import { Composer } from "../components/Composer";
import { RoutingChips } from "../components/RoutingChips";
import { ProjectSettings } from "./ProjectSettings";

/* The screen you land on: a composer, then what is running, then what ran.
 *
 * The routing controls under the composer show what would be used before you
 * dispatch, not after — automatic routing is only trustworthy when it shows
 * its work first. In v0.1 that is a node and a model picker; the router that
 * chooses them for you lands in v0.4. */

interface ProjectHomeProps {
  project: Project;
  onOpenTask: (taskId: string) => void;
}

export function ProjectHome({ project, onOpenTask }: ProjectHomeProps) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [model, setModel] = useState<string>("");
  const [nodeId, setNodeId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"tasks" | "settings">("tasks");
  const [error, setError] = useState<string>();

  async function refresh() {
    const [t, n, p] = await Promise.all([api.tasks(project.id), api.nodes(), api.providers()]);
    setTasks(t.tasks);
    setNodes(n.nodes);
    setProviders(p.providers);

    /* No preselection: an empty pin means "let the router choose", and the
       chips show what that resolves to. */
  }

  useEffect(() => {
    refresh().catch(() => setError("Could not load this project."));
    /* Cheap poll: the task list is a summary, and only the open thread needs a
       live stream. */
    const timer = setInterval(() => void refresh().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [project.id]);

  const online = nodes.filter((n) => n.status === "online");
  const live = tasks.filter((t) => !["completed", "failed", "cancelled"].includes(t.status));
  const needsYou = live.filter((t) => t.status === "awaiting_approval");
  const recent = tasks.filter((t) => ["completed", "failed", "cancelled"].includes(t.status));

  async function dispatch(prompt: string) {
    setError(undefined);
    try {
      const { task } = await api.createTask({
        projectId: project.id,
        prompt,
        model: model || undefined,
        nodeId: nodeId || undefined,
      });
      await refresh();
      onOpenTask(task.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start that task.");
    }
  }

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-canvas overflow-auto scroll-quiet">
      <header className="h-[46px] flex-none flex items-center gap-3 px-4 md:px-[26px] border-b rule sticky top-0 bg-canvas z-10 overflow-x-auto scroll-quiet">
        <h1 className="font-display text-[14px] font-semibold whitespace-nowrap">{project.name}</h1>
        <span className="hidden sm:inline text-[12.5px] text-tertiary whitespace-nowrap">
          {online.length} node{online.length === 1 ? "" : "s"} online
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="tab"
          data-active={tab === "tasks"}
          onClick={() => setTab("tasks")}
        >
          Tasks
        </button>
        <button
          type="button"
          className="tab"
          data-active={tab === "settings"}
          onClick={() => setTab("settings")}
        >
          Settings
        </button>
        <span className="hidden sm:inline font-mono text-[11px] text-tertiary tnum ml-2 whitespace-nowrap">
          {live.length} running · {needsYou.length} need you
        </span>
      </header>

      {tab === "settings" ? (
        <div className="px-4 md:px-[26px] py-5 md:py-6">
          <ProjectSettings project={project} onChanged={() => void refresh()} />
        </div>
      ) : (
      <div className="px-4 md:px-[26px] py-5 md:py-6 flex flex-col gap-7 max-w-[860px]">
        <div className="flex flex-col gap-2.5">
          <Composer
            placeholder="What should the agent do?"
            hints={[]}
            onChange={setDraft}
            onSend={(text) => {
              setDraft("");
              void dispatch(text);
            }}
          />

          <RoutingChips
            projectId={project.id}
            prompt={draft}
            pinnedNodeId={nodeId || undefined}
            pinnedModel={model || undefined}
            onPinNode={(id) => setNodeId(id ?? "")}
            onPinModel={(m) => setModel(m ?? "")}
          />

          {online.length === 0 && (
            <div className="text-[12.5px] text-warn-hi border border-[var(--border-warn)] bg-raised rounded-lg px-3 py-2">
              No node is online, so tasks cannot run. Add one from Fleet.
            </div>
          )}
          {providers.length === 0 && (
            <div className="text-[12.5px] text-warn-hi border border-[var(--border-warn)] bg-raised rounded-lg px-3 py-2">
              No provider is connected. Add one in Providers before running a task.
            </div>
          )}
          {error && (
            <div className="text-[12.5px] text-bad-hi border border-[var(--border-warn)] bg-raised rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {live.length > 0 && (
          <Section title="Running">
            {live.map((task) => (
              <TaskRow key={task.id} task={task} onOpen={() => onOpenTask(task.id)} />
            ))}
          </Section>
        )}

        {recent.length > 0 && (
          <Section title="Recent">
            {recent.slice(0, 20).map((task) => (
              <TaskRow key={task.id} task={task} onOpen={() => onOpenTask(task.id)} />
            ))}
          </Section>
        )}

        {tasks.length === 0 && (
          <div className="text-[13px] text-faint">
            Nothing has run in this project yet. Describe a task above to start.
          </div>
        )}
      </div>
      )}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">{title}</h2>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}


const dotFor: Record<TaskStatus, string> = {
  queued: "dot dot-idle",
  assigned: "dot dot-idle",
  running: "dot dot-live",
  awaiting_approval: "dot dot-needs",
  completed: "dot dot-done",
  failed: "dot dot-off",
  cancelled: "dot dot-idle",
};

function TaskRow({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-2.5 border rule rounded-lg px-3 py-2.5 bg-raised text-left hover:border-[var(--border-strong)] transition-colors"
    >
      <span className={dotFor[task.status]} />
      <span className="text-[13px] font-medium truncate flex-1">{task.title}</span>
      {task.status === "awaiting_approval" && (
        <span className="font-mono text-[10.5px] text-warn-hi flex-none">needs you</span>
      )}
      {task.model && <span className="font-mono text-[10px] text-faint flex-none">{task.model}</span>}
      {task.costUsd > 0 && (
        <span className="font-mono text-[10.5px] text-tertiary tnum flex-none">
          ${task.costUsd.toFixed(3)}
        </span>
      )}
      <span className="font-mono text-[10.5px] text-faint flex-none">{task.status}</span>
    </button>
  );
}
