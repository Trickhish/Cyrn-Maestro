import { useEffect, useState } from "react";
import { api } from "../lib/api";

/* What the router would do, shown before it does it.
 *
 * The chips are the whole argument for automatic routing being acceptable: the
 * choice, the reason, and the alternatives one click away. A router that
 * explains itself only afterwards is one people turn off. */

interface Plan {
  node: { picked: { id: string; name: string }; because: string; alternatives: Array<{ id: string; name: string }> } | null;
  model: { picked: { id: string; tier: string }; because: string; alternatives: Array<{ id: string; tier: string }> } | null;
  tier: string;
  approvals: string;
  blocked?: string;
}

interface RoutingChipsProps {
  projectId: string;
  prompt: string;
  pinnedNodeId?: string;
  pinnedModel?: string;
  onPinNode: (nodeId: string | undefined) => void;
  onPinModel: (model: string | undefined) => void;
}

export function RoutingChips({
  projectId,
  prompt,
  pinnedNodeId,
  pinnedModel,
  onPinNode,
  onPinModel,
}: RoutingChipsProps) {
  const [plan, setPlan] = useState<Plan>();
  const [open, setOpen] = useState<"node" | "model" | null>(null);

  /* Re-planned as the prompt changes, because the tier depends on what was
     typed — but debounced, since this hits the database on every keystroke
     otherwise. */
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .planTask({ projectId, prompt, nodeId: pinnedNodeId, model: pinnedModel })
        .then((p) => {
          if (!cancelled) setPlan(p);
        })
        .catch(() => {});
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, prompt, pinnedNodeId, pinnedModel]);

  if (!plan) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          label="node"
          value={plan.node?.picked.name ?? "none online"}
          because={plan.node?.because}
          pinned={Boolean(pinnedNodeId)}
          open={open === "node"}
          onToggle={() => setOpen(open === "node" ? null : "node")}
          options={[
            ...(pinnedNodeId ? [{ id: "", label: "Let Maestro choose" }] : []),
            ...(plan.node?.alternatives ?? []).map((n) => ({ id: n.id, label: n.name })),
          ]}
          onPick={(id) => {
            onPinNode(id || undefined);
            setOpen(null);
          }}
        />

        <Chip
          label="model"
          value={plan.model?.picked.id ?? "none usable"}
          because={plan.model?.because}
          pinned={Boolean(pinnedModel)}
          open={open === "model"}
          onToggle={() => setOpen(open === "model" ? null : "model")}
          options={[
            ...(pinnedModel ? [{ id: "", label: "Let Maestro choose" }] : []),
            ...(plan.model?.alternatives ?? []).map((m) => ({
              id: m.id,
              label: `${m.id} · ${m.tier}`,
            })),
          ]}
          onPick={(id) => {
            onPinModel(id || undefined);
            setOpen(null);
          }}
        />

        <span className="flex items-center gap-1.5 border rule rounded-md px-2 py-1 bg-surface">
          <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-faint">
            approvals
          </span>
          <span className="text-[12px] text-secondary">writes ask first</span>
        </span>
      </div>

      {plan.blocked && (
        <div className="text-[12.5px] text-warn-hi border border-[var(--border-warn)] bg-raised rounded-lg px-3 py-2">
          {plan.blocked}
        </div>
      )}
    </div>
  );
}

function Chip({
  label,
  value,
  because,
  pinned,
  open,
  options,
  onToggle,
  onPick,
}: {
  label: string;
  value: string;
  because?: string;
  pinned: boolean;
  open: boolean;
  options: Array<{ id: string; label: string }>;
  onToggle: () => void;
  onPick: (id: string) => void;
}) {
  return (
    <span className="relative">
      <button
        type="button"
        onClick={onToggle}
        /* The reason is the tooltip as well as the dropdown header, so it is
           reachable without committing to a change. */
        title={because}
        className="flex items-center gap-1.5 border rule rounded-md px-2 py-1 bg-surface hover:border-[var(--border-strong)] transition-colors"
      >
        <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-faint">{label}</span>
        <span className="text-[12px] text-secondary max-w-[220px] truncate">{value}</span>
        {pinned && <span className="font-mono text-[9px] text-accent-hi">pinned</span>}
        <span className="text-faint text-[9px]">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[240px] rounded-lg border rule-default bg-surface p-1 shadow-lg">
          {because && (
            <div className="px-2 py-1.5 text-[11.5px] leading-snug text-tertiary border-b rule mb-1">
              {because}
            </div>
          )}
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] text-faint">Nothing else available.</div>
          ) : (
            options.map((option) => (
              <button
                key={option.id || "auto"}
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-[12.5px] text-secondary hover:bg-raised hover:text-primary"
                onClick={() => onPick(option.id)}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      )}
    </span>
  );
}
