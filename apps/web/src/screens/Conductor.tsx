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
  usedTools?: string[];
  model?: string;
  error?: boolean;
}

export function Conductor({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => api.tasks().then((t) => setTasks(t.tasks)).catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  const live = tasks.filter((t) => !["completed", "failed", "cancelled"].includes(t.status));
  const needsYou = live.filter((t) => t.status === "awaiting_approval");

  async function ask(question: string) {
    setMessages((m) => [...m, { role: "user", content: question }]);
    setBusy(true);

    try {
      const history = messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
      const answer = await api.askConductor(question, history);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: answer.text,
          usedTools: answer.usedTools.map((t) => t.name),
          model: answer.model,
        },
      ]);
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

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-canvas">
      <header className="h-[46px] flex-none flex items-center gap-3 px-[26px] border-b rule">
        <h1 className="font-display text-[14px] font-semibold">Conductor</h1>
        <span className="text-[12.5px] text-tertiary">the conversation about everything</span>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-tertiary tnum">
          {live.length} running · {needsYou.length} need you
        </span>
      </header>

      <div
        ref={scroller}
        className="flex-1 min-h-0 overflow-auto scroll-quiet px-[26px] py-5 flex flex-col gap-[18px]"
      >
        {messages.length === 0 && (
          <div className="flex flex-col gap-4 max-w-[760px]">
            <p className="prose-msg">
              Ask about anything across your projects — what is running, what needs you, what a
              task changed, where the tokens went.
            </p>

            {live.length > 0 && (
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
            <div className="flex items-center gap-2.5">
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
                <Linked text={message.content} tasks={tasks} onOpenTask={onOpenTask} />
              ) : (
                message.content
              )}
            </div>

            {/* Shows its work: which lookups the answer came from, so it is
                not asking to be taken on trust. */}
            {message.usedTools?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {[...new Set(message.usedTools)].map((tool) => (
                  <span
                    key={tool}
                    className="font-mono text-[10px] text-faint border rule rounded px-1.5 py-0.5"
                  >
                    {tool}
                  </span>
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

      <footer className="flex-none border-t rule px-[26px] pt-3 pb-3.5">
        <Composer
          chip="read-only"
          placeholder="Ask about everything"
          hints={["⏎ send", "the Conductor can report, but not yet dispatch"]}
          onSend={(text) => void ask(text)}
        />
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
}: {
  text: string;
  tasks: TaskSummary[];
  onOpenTask: (taskId: string) => void;
}) {
  const parts = text.split(/\[([0-9a-f-]{8,})\]/gi);

  return (
    <>
      {parts.map((part, i) => {
        /* Odd indices are the captured ids. */
        if (i % 2 === 0) return <span key={i}>{part}</span>;

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
