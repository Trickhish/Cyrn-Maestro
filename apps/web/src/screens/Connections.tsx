import { useEffect, useState } from "react";
import { api, type NodeSummary, type Provider } from "../lib/api";
import { NodesPanel } from "./connections/NodesPanel";
import { ProvidersPanel } from "./connections/ProvidersPanel";
import { McpPanel } from "./connections/McpPanel";
import { ModelsPanel } from "./connections/ModelsPanel";

/* Everything Maestro talks to, in one place.
 *
 * Four kinds, and the distinction is worth keeping visible: machines that run
 * the work, providers that supply the thinking, MCP servers that reach systems
 * outside, and named lists that curate how the thinking gets chosen. They were
 * previously all called "Fleet", which described only the first. */

export type ConnectionsTab = "nodes" | "providers" | "mcp" | "models";

const TABS: Array<{ id: ConnectionsTab; label: string }> = [
  { id: "nodes", label: "Nodes" },
  { id: "providers", label: "Providers" },
  { id: "mcp", label: "MCP" },
  { id: "models", label: "Models" },
];

export function Connections({
  tab,
  onTab,
  ownerLabel,
}: {
  tab: ConnectionsTab;
  onTab: (tab: ConnectionsTab) => void;
  /* Whose connections these are — the active organization, or the account. */
  ownerLabel: string;
}) {
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);

  async function refresh() {
    const [n, p] = await Promise.all([api.nodes(), api.providers()]);
    setNodes(n.nodes);
    setProviders(p.providers);
  }

  useEffect(() => {
    void refresh().catch(() => {});
    /* Node status changes on its own; the other two only change when someone
       edits them, so one poll covers all three cheaply. */
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, []);

  const online = nodes.filter((n) => n.status === "online").length;
  const usableModels = providers.reduce(
    (n, p) => n + p.models.filter((m) => m.enabled && m.probeOk !== false).length,
    0,
  );

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-canvas overflow-auto scroll-quiet">
      <header className="h-[46px] flex-none flex items-center gap-1 px-4 md:px-[26px] border-b rule sticky top-0 bg-canvas z-10 overflow-x-auto scroll-quiet">
        <h1 className="font-display text-[14px] font-semibold mr-3 whitespace-nowrap">Connections</h1>

        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="tab"
            data-active={tab === entry.id}
            onClick={() => onTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}

        {/* The mobile bar already names the owner. */}
        <span className="hidden md:inline text-[12.5px] text-tertiary">{ownerLabel}</span>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-tertiary tnum whitespace-nowrap">
          {online}/{nodes.length} nodes · {usableModels} models
        </span>
      </header>

      <div className="px-4 md:px-[26px] py-5 md:py-6 max-w-[860px]">
        {tab === "nodes" && <NodesPanel nodes={nodes} onChanged={() => void refresh()} />}
        {tab === "providers" && (
          <ProvidersPanel providers={providers} onChanged={() => void refresh()} />
        )}
        {tab === "mcp" && <McpPanel ownerLabel={ownerLabel} />}
        {tab === "models" && <ModelsPanel providers={providers} ownerLabel={ownerLabel} />}
      </div>
    </section>
  );
}
