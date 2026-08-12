import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Project, type ProjectKnowledge as Knowledge, type ProjectNote } from "../lib/api";

/* What a project knows about itself, beyond its code.
 *
 * A project usually already exists somewhere before Maestro is pointed at it —
 * a checkout on a machine, a staging URL, a port nothing else is using — and
 * this is where that gets written down once instead of re-explained every
 * conversation. Everything here has an identical agent tool
 * (set_project_brief, set_workspace_path, add_project_fact, remember, forget)
 * — this panel and the agent write to the same record, so whichever one
 * registers something, the other sees it immediately. */

const KIND_LABEL: Record<string, string> = { directory: "directory", url: "URL", port: "port" };

export function ProjectKnowledge({
  project,
  nodes,
}: {
  project: Project;
  nodes: Array<{ id: string; name: string }>;
}) {
  const [knowledge, setKnowledge] = useState<Knowledge>();
  const [error, setError] = useState<string>();

  async function refresh() {
    try {
      setKnowledge(await api.knowledge(project.id));
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load what this project knows.");
    }
  }

  useEffect(() => {
    void refresh();
  }, [project.id]);

  if (!knowledge) {
    return error ? (
      <p className="text-[13px] text-bad-hi">{error}</p>
    ) : (
      <p className="text-[13px] text-faint">Loading…</p>
    );
  }

  const facts = knowledge.notes.filter((n) => n.kind !== "memory");
  const memories = knowledge.notes.filter((n) => n.kind === "memory");

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">
          What this project knows
        </h2>
        <p className="text-[12.5px] text-tertiary leading-[1.55]">
          Where its code already lives, and anything worth remembering between tasks. Tell an agent
          directly — "this already exists at /path on MAIN.SRV" — and it can register this itself with
          the same tools this page uses.
        </p>
      </div>

      <BriefField projectId={project.id} brief={knowledge.brief} onChanged={refresh} />
      <WorkspaceSection projectId={project.id} workspaces={knowledge.workspaces} nodes={nodes} onChanged={refresh} />
      <FactsSection projectId={project.id} facts={facts} nodes={nodes} onChanged={refresh} />
      <MemoriesSection projectId={project.id} memories={memories} onChanged={refresh} />

      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}
    </section>
  );
}

function BriefField({
  projectId,
  brief,
  onChanged,
}: {
  projectId: string;
  brief: string | null;
  onChanged: () => void;
}) {
  return (
    <Labelled label="Brief" hint="Prepended to every task on this project.">
      <textarea
        className={`${fieldClass} min-h-[72px] resize-y`}
        defaultValue={brief ?? ""}
        placeholder="What this project is, and anything an agent should always know before working on it."
        onBlur={async (e) => {
          const next = e.target.value.trim();
          if (next === (brief ?? "")) return;
          await api.setProjectBrief(projectId, next || null);
          onChanged();
        }}
      />
    </Labelled>
  );
}

function WorkspaceSection({
  projectId,
  workspaces,
  nodes,
  onChanged,
}: {
  projectId: string;
  workspaces: Knowledge["workspaces"];
  nodes: Array<{ id: string; name: string }>;
  onChanged: () => void;
}) {
  const [nodeId, setNodeId] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const registered = new Set(workspaces.map((w) => w.nodeId));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!nodeId || !path.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.setWorkspacePath(projectId, nodeId, path.trim());
      setPath("");
      setNodeId("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h3 className="font-mono text-[10px] tracking-[0.1em] uppercase text-faint">Where it lives</h3>
        <p className="text-[11.5px] text-faint leading-snug">
          Per machine — a path is only ever meaningful on one filesystem. Takes effect the next time a
          task is dispatched to that machine.
        </p>
      </div>

      {workspaces.map((ws) => (
        <WorkspaceRow key={ws.nodeId} workspace={ws} projectId={projectId} onChanged={onChanged} />
      ))}

      {nodes.filter((n) => !registered.has(n.id)).length > 0 && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
          <Labelled label="Machine">
            <select
              className={fieldClass}
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
            >
              <option value="">Choose one</option>
              {nodes
                .filter((n) => !registered.has(n.id))
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
            </select>
          </Labelled>
          <Labelled label="Path">
            <input
              className={fieldClass}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/root/prog/ai_novel"
            />
          </Labelled>
          <button type="submit" className="btn btn-sm" disabled={busy || !nodeId || !path.trim()}>
            {busy ? "Saving…" : "Register"}
          </button>
        </form>
      )}

      {error && <div className="text-[12px] text-bad-hi">{error}</div>}
    </div>
  );
}

function WorkspaceRow({
  workspace,
  projectId,
  onChanged,
}: {
  workspace: Knowledge["workspaces"][number];
  projectId: string;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(workspace.path);
  const [saving, setSaving] = useState(false);

  async function save() {
    const next = path.trim();
    if (!next || next === workspace.path) {
      setPath(workspace.path);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await api.setWorkspacePath(projectId, workspace.nodeId, next);
      setEditing(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border rule rounded-lg px-3 py-2 bg-raised">
      <span className="font-mono text-[11.5px] text-secondary flex-none">{workspace.nodeName}</span>
      {editing ? (
        <input
          autoFocus
          className={`${fieldClass} flex-1 min-w-[200px]`}
          value={path}
          disabled={saving}
          onChange={(e) => setPath(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setPath(workspace.path);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="font-mono text-[11.5px] text-tertiary hover:underline decoration-dotted underline-offset-2 flex-1 min-w-[200px] text-left truncate"
          onClick={() => setEditing(true)}
          title="Click to change"
        >
          {workspace.path}
        </button>
      )}
    </div>
  );
}

function FactsSection({
  projectId,
  facts,
  nodes,
  onChanged,
}: {
  projectId: string;
  facts: ProjectNote[];
  nodes: Array<{ id: string; name: string }>;
  onChanged: () => void;
}) {
  const [kind, setKind] = useState<"directory" | "url" | "port">("url");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!label.trim() || !value.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.addProjectFact(projectId, kind, label.trim(), value.trim(), nodeId || null);
      setLabel("");
      setValue("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h3 className="font-mono text-[10px] tracking-[0.1em] uppercase text-faint">Facts</h3>
        <p className="text-[11.5px] text-faint leading-snug">
          Directories besides the root, URLs, ports. Registering the same label again replaces the value.
        </p>
      </div>

      {facts.length === 0 && <p className="text-[12.5px] text-faint">Nothing registered yet.</p>}

      {facts.map((fact) => (
        <div
          key={fact.id}
          className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border rule rounded-lg px-3 py-2 bg-raised"
        >
          <span className="font-mono text-[9.5px] text-faint uppercase tracking-wide flex-none">
            {KIND_LABEL[fact.kind] ?? fact.kind}
          </span>
          <span className="text-[12.5px] font-medium flex-none">{fact.label}</span>
          <span className="font-mono text-[11.5px] text-tertiary truncate flex-1">{fact.value}</span>
          {fact.nodeName && (
            <span className="font-mono text-[9.5px] text-faint flex-none">{fact.nodeName}</span>
          )}
          <button
            type="button"
            className="btn btn-chip"
            onClick={async () => {
              await api.deleteProjectNote(fact.id);
              onChanged();
            }}
          >
            Remove
          </button>
        </div>
      ))}

      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <Labelled label="Kind">
          <select className={fieldClass} value={kind} onChange={(e) => setKind(e.target.value as never)}>
            <option value="directory">directory</option>
            <option value="url">URL</option>
            <option value="port">port</option>
          </select>
        </Labelled>
        <Labelled label="Label">
          <input
            className={fieldClass}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={kind === "directory" ? "assets" : kind === "url" ? "staging" : "dev server"}
          />
        </Labelled>
        <Labelled label="Value">
          <input
            className={fieldClass}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              kind === "directory"
                ? "/root/prog/ai_novel/assets"
                : kind === "url"
                  ? "https://staging.example.com"
                  : "4000"
            }
          />
        </Labelled>
        {kind === "directory" && (
          <Labelled label="Machine" hint="A directory only means something on one filesystem.">
            <select className={fieldClass} value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
              <option value="">Choose one</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </Labelled>
        )}
        <button type="submit" className="btn btn-sm" disabled={busy || !label.trim() || !value.trim()}>
          {busy ? "Saving…" : "Add"}
        </button>
      </form>

      {error && <div className="text-[12px] text-bad-hi">{error}</div>}
    </div>
  );
}

function MemoriesSection({
  projectId,
  memories,
  onChanged,
}: {
  projectId: string;
  memories: ProjectNote[];
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.addProjectMemory(projectId, text.trim());
      setText("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h3 className="font-mono text-[10px] tracking-[0.1em] uppercase text-faint">Memories</h3>
        <p className="text-[11.5px] text-faint leading-snug">
          Notes for a future task — a decision made, something learned about how it works. Each one adds
          a new entry rather than replacing the last.
        </p>
      </div>

      {memories.length === 0 && <p className="text-[12.5px] text-faint">Nothing remembered yet.</p>}

      {memories.map((memory) => (
        <div
          key={memory.id}
          className="flex items-start gap-2.5 border rule rounded-lg px-3 py-2 bg-raised"
        >
          <span className="text-[12.5px] text-secondary flex-1 leading-snug">{memory.value}</span>
          <span className="font-mono text-[10px] text-faint flex-none whitespace-nowrap">
            {relativeTime(memory.createdAt)}
          </span>
          <button
            type="button"
            className="btn btn-chip flex-none"
            onClick={async () => {
              await api.deleteProjectNote(memory.id);
              onChanged();
            }}
          >
            Remove
          </button>
        </div>
      ))}

      <form className="flex items-start gap-2" onSubmit={submit}>
        <input
          className={`${fieldClass} flex-1`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="The generator script lives in scripts/generate.py."
        />
        <button type="submit" className="btn btn-sm flex-none" disabled={busy || !text.trim()}>
          {busy ? "Saving…" : "Remember"}
        </button>
      </form>

      {error && <div className="text-[12px] text-bad-hi">{error}</div>}
    </div>
  );
}

const fieldClass =
  "w-full bg-surface border rule-default rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--border-accent)]";

function Labelled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-[140px]">
      <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-faint">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint leading-snug">{hint}</span>}
    </label>
  );
}

function relativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
