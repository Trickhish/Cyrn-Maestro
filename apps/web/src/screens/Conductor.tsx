import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ConductorProgress, type TaskSummary } from "../lib/api";
import { Composer, type SlashCommand } from "../components/Composer";

/* The conversation about all of them.
 *
 * The load-bearing rule: this never interleaves six agents' raw tool calls into
 * one feed — that is unreadable within a minute of real use. It narrates at the
 * milestone level and embeds live task cards that update in place, so six
 * running tasks stay a fixed block of the chat rather than a scrolling log. */

interface Message {
  role: "user" | "assistant";
  content: string;
  usedTools?: Array<{ name: string; args: unknown; result: string }>;
  model?: string;
  error?: boolean;
  /* Tasks this turn dispatched. Rendered as live cards under the message and
     followed up on when they finish, so work the Conductor started is visible
     in the conversation that started it rather than only in the task list. */
  dispatched?: string[];
}

const TERMINAL = ["completed", "failed", "cancelled"];

interface ConductorProps {
  onOpenTask: (taskId: string) => void;
  /* Set when this is the panel embedded on one project's own tasks page,
     rather than the global, cross-project screen. Scopes what it asks about
     and, going into every request, which project a bare create_task/
     list_model_lists call defaults to. */
  projectId?: string;
  /* Trades the full-page header and copy for something that fits inside a
     panel alongside a project's task list. */
  embedded?: boolean;
  /* What the routing chips are pinned to, if anything. Passed through so a
     dispatch the Conductor makes without naming a model of its own still
     honours what the user picked by hand. */
  pinnedModel?: string;
  pinnedModelList?: string;
  pinnedNodeId?: string;
  /* Forces which model the Conductor itself reasons on, within its profile. */
  conductorModel?: string;
  /* Rendered between the composer and the thread — the routing chips live
     here so the one input on the page keeps its routing controls. */
  under?: React.ReactNode;
  onDispatched?: () => void;
}

export function Conductor({
  onOpenTask,
  projectId,
  embedded,
  pinnedModel,
  pinnedModelList,
  pinnedNodeId,
  conductorModel,
  under,
  onDispatched,
}: ConductorProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  /* The live trail of what the current turn is doing, newest last. Reset at the
     start of each turn and cleared when the answer lands. */
  const [progress, setProgress] = useState<ConductorProgress[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  /* The ids of the thread as the server last showed it, so a poll can tell
     "nothing new" from "something was added" without diffing content. */
  const serverIds = useRef("");
  /* Local, un-persisted messages: the question just typed and any error, which
     exist in this tab before (or instead of) the server having them. Kept apart
     so a poll can replace the server's half without discarding them. */
  const [local, setLocal] = useState<Message[]>([]);

  /* The thread is the server's, so a reload continues it — and polled rather
     than loaded once, because this tab is no longer the only thing that writes
     to it. A task finishing reports back from a background job on the server
     (conductor/followup.ts), so a conversation left open has to notice work
     appearing in it that nobody in this tab asked for. */
  const refresh = useCallback(async () => {
    const r = await api.conductorHistory(projectId).catch(() => null);
    if (!r) return;

    /* Cheap identity for the thread. Unchanged means nothing to do —
       re-rendering the whole conversation every few seconds would fight with
       expanded tool rows and the scroll position. */
    const ids = r.messages.map((m) => m.id).join(",");
    if (ids === serverIds.current) return;
    serverIds.current = ids;

    setMessages(
      r.messages.map((m) => ({
        role: m.role,
        content: m.content,
        model: m.model ?? undefined,
        usedTools: m.usedTools?.length ? m.usedTools : undefined,
        ...(m.dispatched?.length ? { dispatched: m.dispatched } : {}),
      })),
    );
    /* Whatever the server now has, it has — the optimistic copy of the
       question has served its purpose. Errors stay: they were never persisted,
       so nothing in the thread would replace them. */
    setLocal((l) => l.filter((m) => m.error));
  }, [projectId]);

  useEffect(() => {
    serverIds.current = "";
    setMessages([]);
    setLocal([]);

    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const load = () => api.tasks(projectId).then((t) => setTasks(t.tasks)).catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [projectId]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, local.length, busy]);

  const live = tasks.filter((t) => !TERMINAL.includes(t.status));
  const needsYou = live.filter((t) => t.status === "awaiting_approval");

  /* What the conversation actually reads as: the persisted thread, then
     whatever only this tab knows about — the question in flight and any error
     the server never kept. */
  const shown = [...messages, ...local];

  /* Both halves of the turn are persisted by the server, so the answer is not
     appended here — the poll above picks up the question and the answer
     together, in the form they will have on every future load. Until then the
     question shows optimistically, because waiting up to four seconds to see
     what you just typed reads as a dropped message. */
  async function ask(question: string) {
    const typed: Message = { role: "user", content: question };
    setLocal((l) => [...l.filter((m) => !m.error), typed]);
    setBusy(true);
    setProgress([]);

    try {
      const answer = await api.askConductor(
        question,
        [],
        {
          projectId,
          pinnedModel: pinnedModel || undefined,
          pinnedModelList: pinnedModelList || undefined,
          pinnedNodeId: pinnedNodeId || undefined,
          conductorModel: conductorModel || undefined,
        },
        (event) => setProgress((p) => [...p, event]),
      );

      /* Force the next poll to take the thread even though it may look
         unchanged by id alone, then let it render both messages at once. */
      serverIds.current = "";
      await refresh();

      /* A turn that dispatched something changes the task list behind this
         panel, so the page refreshes rather than waiting out its poll. */
      if (answer.dispatched?.length) onDispatched?.();
    } catch (err) {
      /* Errors are never persisted, so this one lives only in this tab —
         alongside the question that caused it, which the server did not keep
         either. */
      setLocal((l) => [
        ...l,
        {
          role: "assistant",
          content: err instanceof ApiError ? err.message : "Could not reach the Conductor.",
          error: true,
        },
      ]);
    } finally {
      setBusy(false);
      setProgress([]);
    }
  }

  /* Wipes the persisted thread on the server too, not just the local view —
     otherwise the next reload brings the "cleared" messages right back. */
  async function clearThread() {
    setMessages([]);
    setLocal([]);
    serverIds.current = "";
    await api.clearConductorHistory(projectId).catch(() => {});
  }

  const commands: SlashCommand[] = [
    { name: "clear", description: "Clear the conversation", run: () => void clearThread() },
  ];

  const composer = (
    <Composer
      chip={embedded ? undefined : "dispatches work"}
      placeholder={embedded ? "What should the agent do?" : "Ask about everything"}
      hints={
        embedded
          ? ["⏎ send", "/ for commands", "the Conductor picks a model and dispatches the work"]
          : ["⏎ send", "/ for commands", "can dispatch tasks and pick a model list for them"]
      }
      commands={commands}
      onSend={(text) => void ask(text)}
    />
  );

  return (
    <section className={embedded ? "flex-1 min-h-0 flex flex-col" : "flex-1 min-w-0 flex flex-col bg-canvas"}>
      {!embedded && (
        <header className="h-[46px] flex-none flex items-center gap-3 px-4 md:px-[26px] border-b rule overflow-x-auto scroll-quiet">
          <h1 className="font-display text-[14px] font-semibold whitespace-nowrap">Conductor</h1>
          <span className="hidden md:inline text-[12.5px] text-tertiary">the conversation about everything</span>
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-tertiary tnum whitespace-nowrap">
            {live.length} running · {needsYou.length} need you
          </span>
        </header>
      )}

      {/* Embedded, this is the page's one input: it sits at the top where the
          direct composer used to, with the routing chips under it, and the
          conversation reads downward from there. */}
      <div
        ref={scroller}
        className="flex-1 min-h-0 overflow-auto scroll-quiet px-4 md:px-[26px] py-5 flex flex-col gap-[18px]"
      >
        {shown.length === 0 && (
          <div className="flex flex-col gap-4 max-w-[760px]">
            <p className="prose-msg">
              {embedded
                ? "Describe what you want done and the Conductor picks a model and dispatches it, or ask it about the project and what has run here."
                : "Ask about anything across your projects — what is running, what needs you, what a task changed, where the tokens went."}
            </p>

            {/* Embedded, the drawer beside this already lists them. */}
            {!embedded && live.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="speaker">running now</div>
                {live.map((task) => (
                  <TaskCard key={task.id} task={task} onOpen={() => onOpenTask(task.id)} />
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-1.5">
              {[
                "What's running?",
                "Is anything waiting on me?",
                "What did we ship today?",
                "Where did the tokens go?",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void ask(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {shown.map((message, i) => (
          <div key={i} className="flex flex-col gap-2 max-w-[760px]">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="speaker">{message.role === "user" ? "you" : "conductor"}</span>
              {message.model && (
                <span className="font-mono text-[10px] text-plan">{message.model}</span>
              )}
            </div>

            {/* Work first, conclusion last: the tools ran before the answer was
                written, so they read where they happened — with their result a
                click away — rather than dangling under the reply that summarises
                them. The dispatched card sits between the two as the visible
                result of the create_task that produced it. */}
            {message.role === "assistant" && message.usedTools?.length ? (
              <div className="flex flex-col">
                {message.usedTools.map((call, j) => (
                  <ToolRow key={j} call={call} />
                ))}
              </div>
            ) : null}

            {message.dispatched?.map((id) => {
              const task = tasks.find((t) => t.id === id);
              return task ? (
                <TaskCard key={id} task={task} onOpen={() => onOpenTask(id)} />
              ) : (
                <div
                  key={id}
                  className="border rule rounded-[10px] px-[13px] py-[11px] flex items-center gap-[9px] bg-raised"
                >
                  <span className="dot dot-lg dot-idle" />
                  <span className="text-[13px] text-tertiary">Dispatching…</span>
                </div>
              );
            })}

            {message.content ? (
              <div
                className={
                  message.error
                    ? "text-[13px] text-bad-hi border border-[var(--border-warn)] bg-raised rounded-lg px-3 py-2"
                    : "prose-msg whitespace-pre-wrap"
                }
              >
                {message.role === "assistant" && !message.error ? (
                  <Linked
                    text={message.content}
                    tasks={tasks}
                    onOpenTask={onOpenTask}
                    /* A card for the same task is rendered right above, so the
                       inline link would be the same thing said twice. */
                    plainIds={message.dispatched}
                  />
                ) : (
                  message.content
                )}
              </div>
            ) : null}
          </div>
        ))}

        {busy && <LiveStatus progress={progress} />}
      </div>

      {/* At the bottom, where the conversation ends and a reply is typed —
          the routing controls sit under it rather than between the composer
          and the thread, so they never push the last message out of view. */}
      <footer className="flex-none border-t rule px-4 md:px-[26px] pt-3 pb-3.5 flex flex-col gap-2.5">
        {composer}
        {under}
      </footer>
    </section>
  );
}

/* Task ids come back as [uuid]. Turning them into the task's title, clickable,
   is what makes the answer usable rather than a wall of identifiers. */
function Linked({
  text,
  tasks,
  onOpenTask,
  plainIds,
}: {
  text: string;
  tasks: TaskSummary[];
  onOpenTask: (taskId: string) => void;
  /* Ids that already have a card of their own below this message. Rendering
     them as links too would say the same thing twice, so they are dropped
     from the sentence entirely. */
  plainIds?: string[];
}) {
  const parts = text.split(/\[([0-9a-f-]{8,})\]/gi);

  return (
    <>
      {parts.map((part, i) => {
        /* Odd indices are the captured ids. */
        if (i % 2 === 0) return <span key={i}>{part}</span>;
        if (plainIds?.includes(part)) return null;

        const task = tasks.find((t) => t.id === part);
        return (
          <button
            key={i}
            type="button"
            className="text-accent-hi hover:underline"
            onClick={() => onOpenTask(part)}
          >
            {task ? task.title : "open task"} ↗
          </button>
        );
      })}
    </>
  );
}

function TaskCard({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  const blocked = task.status === "awaiting_approval";

  return (
    <div
      className={`border rounded-[10px] px-[13px] py-[11px] flex flex-col gap-2 bg-raised ${
        blocked ? "border-[var(--border-warn)]" : "rule"
      }`}
    >
      <div className="flex items-center gap-[9px]">
        <span className={blocked ? "dot dot-lg dot-needs" : "dot dot-lg dot-live"} />
        <span className="text-[13px] font-semibold truncate">{task.title}</span>
        <span className="font-mono text-[10px] text-tertiary flex-none">{task.projectName}</span>
        <span className="flex-1" />
        <span className={`font-mono text-[10.5px] flex-none ${blocked ? "text-warn-hi" : "text-tertiary"}`}>
          {blocked ? "needs you" : task.status}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] text-faint">
          {task.nodeName ?? "unassigned"} · {task.model ?? "—"}
        </span>
        <span className="flex-1" />
        <button type="button" className="text-[12px] text-accent-hi" onClick={onOpen}>
          Open thread ↗
        </button>
      </div>
    </div>
  );
}


/* Plain-language names for the conductor's tools, so the live status reads like
   a sentence rather than a function call. Anything unmapped falls back to the
   tool name with its underscores softened. */
const TOOL_LABELS: Record<string, string> = {
  create_task: "Dispatching a task",
  get_task: "Reading a task",
  list_tasks: "Listing tasks",
  list_projects: "Listing projects",
  list_model_lists: "Choosing a model profile",
  project_knowledge: "Reading project knowledge",
  remember: "Recording a note",
  register_fact: "Recording a fact",
  set_project_brief: "Setting the project brief",
};

function stepLabel(step: ConductorProgress): string {
  if (step.phase === "thinking") return "Thinking";
  const base = TOOL_LABELS[step.name] ?? step.name.replace(/_/g, " ");
  return step.summary ? `${base}: ${step.summary}` : base;
}

/* The turn narrating itself while it runs.
 *
 * Each step arrives as it happens; the newest is live (a running dot), the ones
 * before it are done (a faint check). It replaces the old single "Looking…" so
 * a turn spending ten seconds on tool calls says what it is spending them on.
 * The whole thing is torn down the moment the answer lands — this is the wait,
 * not the record; the record is the tool rows on the finished message. */
function LiveStatus({ progress }: { progress: ConductorProgress[] }) {
  if (progress.length === 0) {
    return (
      <div className="flex items-center gap-2.5 max-w-[760px]">
        <span className="dot dot-running" />
        <span className="text-[13px] text-tertiary">Looking…</span>
      </div>
    );
  }

  /* Only the tail: a long turn should not push the conversation off-screen with
     its own scaffolding. */
  const shown = progress.slice(-8);

  return (
    <div className="flex flex-col gap-1.5 max-w-[760px]">
      {shown.map((step, i) => {
        const active = i === shown.length - 1;
        return (
          <div key={i} className="flex items-center gap-2.5">
            <span className="w-3 flex-none flex justify-center">
              {active ? (
                <span className="dot dot-running" />
              ) : (
                <span className="text-plan text-[11px] leading-none">✓</span>
              )}
            </span>
            <span className={`text-[13px] truncate ${active ? "text-secondary" : "text-faint"}`}>
              {stepLabel(step)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* What the Conductor actually did to answer, in the order it did it.
 *
 * The same row a task thread uses, for the same reason: a name alone says
 * something ran, not what it was asked or what came back. Collapsed by
 * default — the answer is the point, and this is the receipt. */
function ToolRow({ call }: { call: { name: string; args: unknown; result: string } }) {
  const [open, setOpen] = useState(false);

  /* The interesting argument, not the whole object: a task's prompt, a
     model list's name, a task id. Falls back to compact JSON. */
  const args = (call.args ?? {}) as Record<string, unknown>;
  const summary =
    [args.prompt, args.title, args.modelList, args.model, args.taskId, args.query, args.text, args.value]
      .find((v) => typeof v === "string" && v) as string | undefined;

  return (
    <div>
      <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="text-faint w-2.5 flex-none">{open ? "▾" : "▸"}</span>
        <span className="text-tertiary w-[112px] flex-none truncate">{call.name}</span>
        <span className="text-secondary truncate">{summary ?? ""}</span>
      </button>

      {open && (
        <pre className="ml-[22px] my-1 px-3 py-2 bg-inset border rule rounded-md font-mono text-[11.5px] leading-[1.6] text-tertiary whitespace-pre-wrap overflow-x-auto scroll-quiet max-h-[300px]">
          {call.result}
        </pre>
      )}
    </div>
  );
}
