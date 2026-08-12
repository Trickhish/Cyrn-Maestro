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
            Run this on the machine you want to add. It is single-use and expires in 15 minutes.
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
        <div
          key={node.id}
          className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border rule rounded-lg px-3 py-2.5 bg-raised"
        >
          <span
            className={
              node.status === "online"
                ? "dot dot-live"
                : node.status === "revoked"
                  ? "dot dot-off"
                  : "dot dot-idle"
            }
          />
          <span className="font-mono text-[12px] text-primary">{node.name}</span>
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
          <button
            type="button"
            className="btn btn-chip"
            disabled={busy === node.id}
            onClick={async () => {
              setBusy(node.id);
              try {
                await api.revokeNode(node.id);
                onChanged();
              } finally {
                setBusy(undefined);
              }
            }}
          >
            Revoke
          </button>
        </div>
      ))}

      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}
    </div>
  );
}
