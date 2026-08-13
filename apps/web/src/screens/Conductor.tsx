import { useEffect, useRef, useState } from "react";
import { api, ApiError, type TaskSummary } from "../lib/api";
import { Composer } from "../components/Composer";

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
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  /* Dispatched task ids already followed up on, so the automatic follow-up
     fires once each. Declared here because history loading seeds it — see the
     effect below and the watcher further down. */
  const reported = useRef(new Set<string>());

  /* The thread is the server's, so a reload continues it. Loaded once per
     project rather than polled: it only changes when this page changes it. */
  useEffect(() => {
    let cancelled = false;
    api
      .conductorHistory(projectId)
      .then((r) => {
        if (!cancelled) {
          setMessages(
            r.messages.map((m) => ({
              role: m.role,
              content: m.content,
              model: m.model ?? undefined,
              usedTools: m.usedTools?.length ? m.usedTools : undefined,
              ...(m.dispatched?.length ? { dispatched: m.dispatched } : {}),
            })),
          );
          /* Anything dispatched in loaded history was already followed up on
             (its answer is in that history) or finished before this page
             existed. Either way it must not trigger a fresh follow-up — that
             is what made the Conductor re-answer the last task on every
             reload. */
          for (const m of r.messages) for (const id of m.dispatched ?? []) reported.current.add(id);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const load = () => api.tasks(projectId).then((t) => setTasks(t.tasks)).catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [projectId]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  const live = tasks.filter((t) => !TERMINAL.includes(t.status));
  const needsYou = live.filter((t) => t.status === "awaiting_approval");

  /* `silent` is for the follow-up the panel fires itself once a dispatched
     task finishes: the Conductor's answer belongs in the thread, but the
     question does not — the user never typed it. */
  async function ask(question: string, silent = false) {
    if (!silent) setMessages((m) => [...m, { role: "user", content: question }]);
    setBusy(true);

    try {
      const answer = await api.askConductor(question, [], {
        projectId,
        pinnedModel: pinnedModel || undefined,
        pinnedModelList: pinnedModelList || undefined,
        pinnedNodeId: pinnedNodeId || undefined,
        conductorModel: conductorModel || undefined,
        silent,
      });

      const dispatched = answer.dispatched ?? [];

      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: answer.text,
          usedTools: answer.usedTools,
          model: answer.model,
          ...(dispatched.length ? { dispatched } : {}),
        },
      ]);

      /* A turn that dispatched something changes the task list behind this
         panel, so the page refreshes rather than waiting out its poll. */
      if (dispatched.length) onDispatched?.();
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: err instanceof ApiError ? err.message : "Could not reach the Conductor.",
          error: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  /* Closing the loop on dispatched work.
   *
   * The Conductor cannot watch a task — a turn ends when it answers. So the
   * panel watches instead, and asks it one more question the moment a task it
   * started reaches a terminal state. Reported ids are remembered in a ref
   * rather than state: the task list is re-polled every four seconds, and
   * anything less durable would ask again on every tick. `reported` is
   * declared with the other refs above, since history loading seeds it. */
  const askRef = useRef(ask);
  askRef.current = ask;

  useEffect(() => {
    if (busy) return;

    const mine = new Set(messages.flatMap((m) => m.dispatched ?? []));
    const done = tasks.find(
      (t) => mine.has(t.id) && TERMINAL.includes(t.status) && !reported.current.has(t.id),
    );
    if (!done) return;

    /* Marked before the call, not after: an in-flight follow-up must not be
       started twice by the next poll. */
    reported.current.add(done.id);
    void askRef.current(
      `The task [${done.id}] you dispatched has finished with status "${done.status}". ` +
        `Read what it actually did with get_task and tell me the outcome in a sentence or two. ` +
        `If it failed or the work needs another pass, say so and what you would dispatch next.`,
      true,
    );
  }, [tasks, messages, busy]);

  const composer = (
    <Composer
      chip={embedded ? undefined : "dispatches work"}
      placeholder={embedded ? "What should the agent do?" : "Ask about everything"}
      hints={
        embedded
          ? ["⏎ send", "the Conductor picks a model and dispatches the work"]
          : ["⏎ send", "can dispatch tasks and pick a model list for them"]
      }
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
        {messages.length === 0 && (
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

        {messages.map((message, i) => (
          <div key={i} className="flex flex-col gap-2 max-w-[760px]">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="speaker">{message.role === "user" ? "you" : "conductor"}</span>
              {message.model && (
                <span className="font-mono text-[10px] text-plan">{message.model}</span>
              )}
            </div>

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
                  /* A card for the same task is rendered right below, so the
                     inline link would be the same thing said twice. */
                  plainIds={message.dispatched}
                />
              ) : (
                message.content
              )}
            </div>

            {/* The dispatched work itself, live and clickable, in the
                conversation that started it. */}
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

            {/* Shows its work: which lookups the answer came from, so it is
                not asking to be taken on trust. */}
            {message.usedTools?.length ? (
              <div className="flex flex-col">
                {message.usedTools.map((call, j) => (
                  <ToolRow key={j} call={call} />
                ))}
              </div>
            ) : null}
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-2.5 max-w-[760px]">
            <span className="dot dot-running" />
            <span className="text-[13px] text-tertiary">Looking…</span>
          </div>
        )}
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
