import { useEffect, useState } from "react";
import {
  api,
  type NodeSummary,
  type Project,
  type Provider,
  type TaskStatus,
  type TaskSummary,
} from "../lib/api";
import { RoutingChips } from "../components/RoutingChips";
import { ProjectSettings } from "./ProjectSettings";
import { Conductor } from "./Conductor";

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
  const [modelList, setModelList] = useState<string>("");
  const [conductorModel, setConductorModel] = useState<string>("");
  const [nodeId, setNodeId] = useState<string>("");
  const [tab, setTab] = useState<"conductor" | "settings">("conductor");
  const [drawer, setDrawer] = useState(true);
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

  return (
    <section className="flex-1 min-w-0 min-h-0 flex flex-col bg-canvas">
      <header className="h-[46px] flex-none flex items-center gap-3 px-4 md:px-[26px] border-b rule overflow-x-auto scroll-quiet">
        <h1 className="font-display text-[14px] font-semibold whitespace-nowrap">{project.name}</h1>
        <span className="hidden sm:inline text-[12.5px] text-tertiary whitespace-nowrap">
          {online.length} node{online.length === 1 ? "" : "s"} online
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="tab"
          data-active={tab === "conductor"}
          onClick={() => setTab("conductor")}
        >
          Conductor
        </button>
        <button
          type="button"
          className="tab"
          data-active={tab === "settings"}
          onClick={() => setTab("settings")}
        >
          Settings
        </button>

        {/* The drawer toggle lives in the header rather than floating over the
            chat: it is a property of the view, and the counts are the reason
            anyone reaches for it. */}
        {tab === "conductor" && (
          <button
            type="button"
            className="btn btn-chip ml-1 flex-none"
            onClick={() => setDrawer(!drawer)}
            title={drawer ? "Hide tasks" : "Show tasks"}
          >
            <span className="font-mono text-[10.5px] tnum">
              {live.length} running{needsYou.length > 0 ? ` · ${needsYou.length} need you` : ""}
            </span>
            <span className="text-faint text-[9px] ml-1.5">{drawer ? "▸" : "◂"}</span>
          </button>
        )}
      </header>

      {tab === "settings" ? (
        <div className="flex-1 min-h-0 overflow-auto scroll-quiet px-4 md:px-[26px] py-5 md:py-6">
          <ProjectSettings project={project} onChanged={() => void refresh()} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          {/* The chat is the page. Everything else is beside it. */}
          <Conductor
            projectId={project.id}
            embedded
            onOpenTask={onOpenTask}
            pinnedModel={model || undefined}
            pinnedModelList={modelList || undefined}
            pinnedNodeId={nodeId || undefined}
            conductorModel={conductorModel || undefined}
            onDispatched={() => void refresh()}
            under={
              <>
                {/* No prompt: the Conductor rewrites what you type before it
                    dispatches, so weighing the raw text would show a plan that
                    is not the one that runs. */}
                <RoutingChips
                  projectId={project.id}
                  prompt=""
                  pinnedNodeId={nodeId || undefined}
                  pinnedModel={model || undefined}
                  pinnedModelList={modelList || undefined}
                  conductorModel={conductorModel || undefined}
                  onPinNode={(id) => setNodeId(id ?? "")}
                  onPinModel={(m) => setModel(m ?? "")}
                  onPinModelList={(name) => setModelList(name ?? "")}
                  onPickConductorModel={(m) => setConductorModel(m ?? "")}
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
              </>
            }
          />

          {drawer && (
            <TasksDrawer live={live} recent={recent} total={tasks.length} onOpenTask={onOpenTask} />
          )}
        </div>
      )}
    </section>
  );
}

/* What has run here, beside the conversation that started it.
 *
 * A drawer rather than a page of its own: the chat is what someone is doing,
 * and the task list is what they glance at while doing it. Rows expand in
 * place — enough to answer "what happened" without losing the conversation,
 * with the full thread one click further for when it is not enough. */
function TasksDrawer({
  live,
  recent,
  total,
  onOpenTask,
}: {
  live: TaskSummary[];
  recent: TaskSummary[];
  total: number;
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <aside className="w-[320px] flex-none border-l rule bg-raised overflow-auto scroll-quiet flex flex-col gap-4 px-3 py-4">
      {total === 0 && (
        <div className="text-[12.5px] text-faint">
          Nothing has run here yet. Ask the Conductor for something and it will appear.
        </div>
      )}

      {live.length > 0 && (
        <Section title="Running">
          {live.map((task) => (
            <TaskRow key={task.id} task={task} onOpen={() => onOpenTask(task.id)} />
          ))}
        </Section>
      )}

      {recent.length > 0 && (
        <Section title="Recent">
          {recent.slice(0, 30).map((task) => (
            <TaskRow key={task.id} task={task} onOpen={() => onOpenTask(task.id)} />
          ))}
        </Section>
      )}
    </aside>
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

/* A row in the drawer, expanding in place.
 *
 * Clicking used to jump straight to the thread, which loses the conversation
 * you were having. Most of the time the question is just "what happened" —
 * which model, what it cost, why it failed — and that fits here. The full
 * thread is one click further for when it does not. */
function TaskRow({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border rule rounded-lg bg-surface overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-raised"
      >
        <span className={dotFor[task.status]} />
        <span className="text-[12.5px] truncate flex-1">{task.title}</span>
        {task.status === "awaiting_approval" && (
          <span className="font-mono text-[10px] text-warn-hi flex-none">needs you</span>
        )}
        <span className="text-faint text-[9px] flex-none">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5 pt-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[10px] text-faint">{task.status}</span>
            {task.nodeName && (
              <span className="font-mono text-[10px] text-faint">{task.nodeName}</span>
            )}
            {task.costUsd > 0 && (
              <span className="font-mono text-[10px] text-tertiary tnum">
                ${task.costUsd.toFixed(3)}
              </span>
            )}
          </div>

          {task.model && (
            <div className="font-mono text-[10px] text-plan break-all">{task.model}</div>
          )}

          {/* The reason it failed is the whole point of expanding a failed
              one, so it is shown rather than truncated to a status word. */}
          {task.error && (
            <div className="text-[11.5px] text-bad-hi leading-snug break-words">{task.error}</div>
          )}

          <button
            type="button"
            className="text-[11.5px] text-accent-hi hover:underline self-start"
            onClick={onOpen}
          >
            Open thread ↗
          </button>
        </div>
      )}
    </div>
  );
}
