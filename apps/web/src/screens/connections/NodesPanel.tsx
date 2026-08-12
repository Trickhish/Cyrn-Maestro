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
}: {
  node: NodeSummary;
  busy: boolean;
  onRevoke: () => void;
  onRename: (name: string) => Promise<void>;
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
      <span className="font-mono text-[10.5px] text-tertiary tnum">
        {node.runningTasks}/{node.maxConcurrentTasks} tasks
      </span>
      <button type="button" className="btn btn-chip" disabled={busy} onClick={onRevoke}>
        Revoke
      </button>
    </div>
  );
}
