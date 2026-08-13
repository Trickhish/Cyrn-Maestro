import { useState } from "react";
import { api, ApiError, type NodeSummary } from "../../lib/api";

/* The machines that run work. */

export function NodesPanel({
  nodes,
  onChanged,
}: {
  nodes: NodeSummary[];
  onChanged: () => void;
}) {
  const [install, setInstall] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <p className="text-[12.5px] text-tertiary leading-[1.55] flex-1">
          Machines that execute tasks. They dial out to Maestro, so they need no public address.
        </p>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={async () => {
            try {
              const { command } = await api.enrollNode();
              setInstall(command);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Could not create a token.");
            }
          }}
        >
          Add node
        </button>
      </div>

      {install && (
        <div className="flex flex-col gap-2 border border-[var(--border-accent)] bg-raised rounded-lg p-3">
          <div className="text-[12.5px] text-secondary">
            Run this on the machine you want to add. It installs Bun if needed, enrols the
            machine, and sets the node up as a service that starts at boot. The token is
            single-use and expires in 15 minutes.
          </div>
          <div className="font-mono text-[11.5px] text-primary bg-inset border rule rounded px-2.5 py-2 overflow-x-auto scroll-quiet whitespace-nowrap">
            {install}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void navigator.clipboard?.writeText(install)}
            >
              Copy
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setInstall(undefined)}>
              Done
            </button>
          </div>
        </div>
      )}

      {nodes.length === 0 && (
        <div className="text-[13px] text-faint">
          No machines yet. Add one and it will appear here within a second or two.
        </div>
      )}

      {nodes.map((node) => (
        <NodeRow
          key={node.id}
          node={node}
          busy={busy === node.id}
          onRevoke={async () => {
            setBusy(node.id);
            try {
              await api.revokeNode(node.id);
              onChanged();
            } finally {
              setBusy(undefined);
            }
          }}
          onRename={async (name) => {
            await api.renameNode(node.id, name);
            onChanged();
          }}
          onSetConcurrency={async (max) => {
            await api.setNodeConcurrency(node.id, max);
            onChanged();
          }}
          onUpdate={async () => {
            const result = await api.updateNode(node.id);
            onChanged();
            return result;
          }}
        />
      ))}

      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}
    </div>
  );
}

/* One machine. The name is a label someone chose — at install with --name, or
   the hostname by default — not an identity, so it is editable here without
   touching the daemon or its token. */
function NodeRow({
  node,
  busy,
  onRevoke,
  onRename,
  onSetConcurrency,
  onUpdate,
}: {
  node: NodeSummary;
  busy: boolean;
  onRevoke: () => void;
  onRename: (name: string) => Promise<void>;
  onSetConcurrency: (max: number | null) => Promise<void>;
  onUpdate: () => Promise<{ ok: boolean; detail: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  const [saving, setSaving] = useState(false);

  async function save() {
    const next = name.trim();
    if (!next || next === node.name) {
      setEditing(false);
      setName(node.name);
      return;
    }
    setSaving(true);
    try {
      await onRename(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border rule rounded-lg px-3 py-2.5 bg-raised">
      <span
        className={
          node.status === "online"
            ? "dot dot-live"
            : node.status === "revoked"
              ? "dot dot-off"
              : "dot dot-idle"
        }
      />

      {editing ? (
        <input
          autoFocus
          value={name}
          disabled={saving}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setName(node.name);
              setEditing(false);
            }
          }}
          className="font-mono text-[12px] text-primary bg-canvas border rule-default rounded px-1.5 py-0.5 outline-none focus:border-[var(--border-accent)] w-[160px]"
        />
      ) : (
        <button
          type="button"
          className="font-mono text-[12px] text-primary hover:underline decoration-dotted underline-offset-2 disabled:no-underline disabled:cursor-default"
          disabled={node.status === "revoked"}
          onClick={() => setEditing(true)}
          title={node.status === "revoked" ? undefined : "Click to rename"}
        >
          {node.name}
        </button>
      )}

      <span className="text-[12px] text-tertiary">
        {node.os} · {node.arch}
      </span>
      <span className="font-mono text-[10.5px] text-faint truncate">
        {node.capabilities.join(" · ")}
      </span>
      <span className="flex-1" />
      {node.updateAvailable && <Update node={node} onUpdate={onUpdate} />}
      <Concurrency node={node} onSet={onSetConcurrency} />
      <button type="button" className="btn btn-chip" disabled={busy} onClick={onRevoke}>
        Revoke
      </button>
    </div>
  );
}

/* How many tasks this machine will take at once.
 *
 * The number lives on the node, which is the right default — it knows its own
 * cores. But changing it meant editing node.toml on the box and restarting,
 * which is a lot of ceremony for one integer, so it is settable here and
 * pushed down the open socket. The machine's own figure is kept visible
 * alongside, or a number that does not match what is configured on the box
 * looks like a bug. */
function Concurrency({
  node,
  onSet,
}: {
  node: NodeSummary;
  onSet: (max: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(node.maxConcurrentTasks));
  const [saving, setSaving] = useState(false);

  async function save() {
    const next = Number(value);
    if (!Number.isInteger(next) || next < 1 || next > 64 || next === node.maxConcurrentTasks) {
      setEditing(false);
      setValue(String(node.maxConcurrentTasks));
      return;
    }
    setSaving(true);
    try {
      await onSet(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <span className="flex items-center gap-1.5">
        <input
          autoFocus
          type="number"
          min={1}
          max={64}
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setValue(String(node.maxConcurrentTasks));
              setEditing(false);
            }
          }}
          className="font-mono text-[11px] text-primary bg-canvas border rule-default rounded px-1.5 py-0.5 outline-none focus:border-[var(--border-accent)] w-[56px] tnum"
        />
        {node.concurrencyOverride != null && (
          <button
            type="button"
            className="text-[11px] text-tertiary hover:text-primary"
            disabled={saving}
            /* onMouseDown, not onClick: the input's blur would commit and
               close the editor before a click ever landed. */
            onMouseDown={(e) => {
              e.preventDefault();
              void onSet(null).then(() => setEditing(false));
            }}
          >
            use {node.reportedConcurrency}
          </button>
        )}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="font-mono text-[10.5px] text-tertiary tnum hover:text-primary hover:underline decoration-dotted underline-offset-2 disabled:no-underline disabled:cursor-default"
      disabled={node.status === "revoked"}
      onClick={() => setEditing(true)}
      title={
        node.concurrencyOverride != null
          ? `Set here to ${node.concurrencyOverride}; this machine's own config says ${node.reportedConcurrency}. Click to change.`
          : "How many tasks this machine takes at once. Click to change."
      }
    >
      {node.runningTasks}/{node.maxConcurrentTasks} tasks
      {node.concurrencyOverride != null && <span className="text-accent-hi"> ·set</span>}
    </button>
  );
}

/* Replaces the daemon on a machine with the one this server is serving.
 *
 * Deliberately a button and not something that happens on its own: nothing on
 * a node can recover from a bundle that will not start, because the only thing
 * that could is the daemon that would have crashed. Someone watching, who can
 * re-run the install one-liner, is the recovery path. The request stays open
 * while the node finishes whatever it is running, so it can take a while and
 * the wait is the honest thing to show. */
function Update({
  node,
  onUpdate,
}: {
  node: NodeSummary;
  onUpdate: () => Promise<{ ok: boolean; detail: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  return (
    <span className="flex items-center gap-1.5">
      {problem && (
        <span className="text-[11px] text-warn-hi max-w-[280px] truncate" title={problem}>
          {problem}
        </span>
      )}
      <button
        type="button"
        className="btn btn-chip"
        disabled={busy}
        title={`Running ${node.version ?? "an unknown version"}. Finishes its current tasks first, then restarts on the new one.`}
        onClick={async () => {
          setBusy(true);
          setProblem(undefined);
          try {
            const result = await onUpdate();
            if (!result.ok) setProblem(result.detail);
          } catch (err) {
            setProblem(err instanceof ApiError ? err.message : "Could not update that node.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Updating…" : "Update"}
      </button>
    </span>
  );
}
