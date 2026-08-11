import { useEffect, useState } from "react";
import { api, ApiError, type NodeSummary, type Provider } from "../lib/api";

/* Fleet and providers: the admin screens. Not the front door — day to day you
   think in projects — but this is where a node gets added and a provider's
   model list gets refreshed. */

export function Fleet() {
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [install, setInstall] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function refresh() {
    const [n, p] = await Promise.all([api.nodes(), api.providers()]);
    setNodes(n.nodes);
    setProviders(p.providers);
  }

  useEffect(() => {
    refresh().catch(() => setError("Could not load the fleet."));
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-canvas overflow-auto scroll-quiet">
      <header className="h-[46px] flex-none flex items-center gap-3 px-[26px] border-b rule sticky top-0 bg-canvas z-10">
        <h1 className="font-display text-[14px] font-semibold">Fleet</h1>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-tertiary">
          {nodes.filter((n) => n.status === "online").length} of {nodes.length} online
        </span>
      </header>

      <div className="px-[26px] py-6 flex flex-col gap-7 max-w-[860px]">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">Nodes</h2>
            <span className="flex-1" />
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
              className="flex items-center gap-2.5 border rule rounded-lg px-3 py-2.5 bg-raised"
            >
              <span
                className={
                  node.status === "online" ? "dot dot-live" : node.status === "revoked" ? "dot dot-off" : "dot dot-idle"
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
                    await refresh();
                  } finally {
                    setBusy(undefined);
                  }
                }}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">Providers</h2>

          {providers.length === 0 && (
            <div className="text-[13px] text-faint">
              No provider connected. Add one with the API, or set MAESTRO_PROVIDER_API_KEY and restart.
            </div>
          )}

          {providers.map((provider) => {
            const usable = provider.models.filter((m) => m.probeOk !== false).length;
            return (
              <div key={provider.id} className="flex flex-col gap-2 border rule rounded-lg px-3 py-2.5 bg-raised">
                <div className="flex items-center gap-2.5">
                  <span className={provider.lastHealthOk === false ? "dot dot-off" : "dot dot-done"} />
                  <span className="text-[13px] font-medium">{provider.name}</span>
                  <span className="font-mono text-[10.5px] text-faint truncate">{provider.baseUrl}</span>
                  <span className="flex-1" />
                  <span className="font-mono text-[10.5px] text-tertiary tnum">
                    {usable}/{provider.models.length} usable
                  </span>
                  <button
                    type="button"
                    className="btn btn-chip"
                    disabled={busy === provider.id}
                    onClick={async () => {
                      setBusy(provider.id);
                      try {
                        await api.refreshProvider(provider.id);
                        await refresh();
                      } finally {
                        setBusy(undefined);
                      }
                    }}
                  >
                    {busy === provider.id ? "Probing…" : "Refresh"}
                  </button>
                </div>

                {/* A model that failed its probe is shown greyed with the reason,
                    not hidden — otherwise the user just wonders where it went. */}
                <div className="flex flex-wrap gap-1.5">
                  {provider.models.map((model) => (
                    <span
                      key={model.id}
                      title={model.probeError ?? undefined}
                      className={`font-mono text-[10.5px] border rounded px-1.5 py-0.5 ${
                        model.probeOk === false
                          ? "rule text-faint line-through"
                          : "border-[var(--border-accent)] text-accent-hi"
                      }`}
                    >
                      {model.modelId}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}
      </div>
    </section>
  );
}
