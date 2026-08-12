import { useEffect, useState } from "react";
import { api, type Project, type ProviderModel, type RoutingRule } from "../lib/api";
import { CapCoverage } from "../components/CapCoverage";

/* Project settings: the middle rungs of the override ladder.
 *
 * Defaults say what this project usually wants; rules say what it wants in
 * particular cases. Both are shown alongside the order they resolve in, because
 * a setting that loses to another one without saying so is worse than no
 * setting at all. */

const TIERS = ["light", "standard", "heavy"] as const;

export function ProjectSettings({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [nodes, setNodes] = useState<Array<{ id: string; name: string }>>([]);
  const [draft, setDraft] = useState<Partial<RoutingRule>>({ name: "", priority: 100 });
  const [error, setError] = useState<string>();

  async function refresh() {
    const [r, p, n] = await Promise.all([api.rules(project.id), api.providers(), api.nodes()]);
    setRules(r.rules);
    setModels(p.providers.flatMap((prov) => prov.models.filter((m) => m.probeOk !== false)));
    setNodes(n.nodes.filter((node) => node.status !== "revoked").map((node) => ({ id: node.id, name: node.name })));
  }

  useEffect(() => {
    refresh().catch(() => setError("Could not load settings."));
  }, [project.id]);

  async function patch(values: Partial<Project>) {
    await api.updateProject(project.id, values);
    onChanged();
  }

  return (
    <div className="flex flex-col gap-8 max-w-[680px]">
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">Defaults</h2>
          <p className="text-[12.5px] text-tertiary leading-[1.55]">
            What this project usually wants. A rule below, or a pin on a task, overrides these.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Labelled label="Tier">
            <select
              className={selectClass}
              value={project.defaultTier ?? ""}
              onChange={(e) => void patch({ defaultTier: (e.target.value || null) as never })}
            >
              <option value="">Let the router decide</option>
              {TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </Labelled>

          <Labelled label="Model">
            <select
              className={selectClass}
              value={project.defaultModelId ?? ""}
              onChange={(e) => void patch({ defaultModelId: e.target.value || null })}
            >
              <option value="">Let the router decide</option>
              {models.map((model) => (
                <option key={model.id} value={model.modelId}>
                  {model.modelId} · {model.tier}
                </option>
              ))}
            </select>
          </Labelled>
        </div>

        <Labelled label="Spend cap (USD)" hint="Leave empty for no cap. Tasks stop rather than exceed it.">
          <input
            className={selectClass}
            defaultValue={project.spendCapUsd ?? ""}
            inputMode="decimal"
            placeholder="No cap"
            onBlur={(e) =>
              void patch({ spendCapUsd: e.target.value === "" ? null : Number(e.target.value) })
            }
          />
        </Labelled>

        <CapCoverage models={models} capSet={project.spendCapUsd != null} />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">
            Routing rules
          </h2>
          <p className="text-[12.5px] text-tertiary leading-[1.55]">
            Checked in order, lowest number first. The first rule that matches wins.
          </p>
        </div>

        {rules.length === 0 && <p className="text-[13px] text-faint">No rules yet.</p>}

        {rules.map((rule) => (
          <div
            key={rule.id}
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border rule rounded-lg px-3 py-2.5 bg-raised"
          >
            <span className={rule.enabled ? "dot dot-running" : "dot dot-idle"} />
            <span className="font-mono text-[10.5px] text-faint tnum w-8">{rule.priority}</span>
            <span className="text-[13px] font-medium">{rule.name}</span>
            <span className="text-[12px] text-tertiary truncate flex-1">
              {describeRule(rule)}
            </span>
            {!rule.projectId && (
              <span className="font-mono text-[9px] text-faint">organization-wide</span>
            )}
            <button
              type="button"
              className="btn btn-chip"
              onClick={async () => {
                await api.updateRule(rule.id, { enabled: !rule.enabled });
                await refresh();
              }}
            >
              {rule.enabled ? "Disable" : "Enable"}
            </button>
            <button
              type="button"
              className="btn btn-chip"
              onClick={async () => {
                await api.deleteRule(rule.id);
                await refresh();
              }}
            >
              Delete
            </button>
          </div>
        ))}

        <form
          className="flex flex-col gap-2 border rule rounded-lg px-3 py-3 bg-surface"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(undefined);
            try {
              await api.createRule({ ...draft, projectId: project.id } as never);
              setDraft({ name: "", priority: 100 });
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not save the rule.");
            }
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_80px] gap-2">
            <Labelled label="Name">
              <input
                className={selectClass}
                value={draft.name ?? ""}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Refactors go big"
                required
              />
            </Labelled>
            <Labelled label="Order">
              <input
                className={selectClass}
                value={draft.priority ?? 100}
                onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                inputMode="numeric"
              />
            </Labelled>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Labelled label="When the prompt contains">
              <input
                className={selectClass}
                value={draft.matchText ?? ""}
                onChange={(e) => setDraft({ ...draft, matchText: e.target.value || null })}
                placeholder="anything"
              />
            </Labelled>
            <Labelled label="…and the tier is">
              <select
                className={selectClass}
                value={draft.matchTier ?? ""}
                onChange={(e) => setDraft({ ...draft, matchTier: (e.target.value || null) as never })}
              >
                <option value="">any</option>
                {TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
            </Labelled>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Labelled label="Then use tier">
              <select
                className={selectClass}
                value={draft.setTier ?? ""}
                onChange={(e) => setDraft({ ...draft, setTier: (e.target.value || null) as never })}
              >
                <option value="">unchanged</option>
                {TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
            </Labelled>
            <Labelled label="and model">
              <select
                className={selectClass}
                value={draft.setModelId ?? ""}
                onChange={(e) => setDraft({ ...draft, setModelId: e.target.value || null })}
              >
                <option value="">unchanged</option>
                {models.map((m) => (
                  <option key={m.id} value={m.modelId}>
                    {m.modelId}
                  </option>
                ))}
              </select>
            </Labelled>
            <Labelled label="and machine">
              <select
                className={selectClass}
                value={draft.setNodeId ?? ""}
                onChange={(e) => setDraft({ ...draft, setNodeId: e.target.value || null })}
              >
                <option value="">unchanged</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </Labelled>
          </div>

          {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}

          <button type="submit" className="btn btn-primary self-start">
            Add rule
          </button>
        </form>
      </section>
    </div>
  );
}

const selectClass =
  "w-full bg-surface border rule-default rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--border-accent)]";

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-faint">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint leading-snug">{hint}</span>}
    </label>
  );
}

function describeRule(rule: RoutingRule): string {
  const when = [
    rule.matchText ? `prompt contains "${rule.matchText}"` : null,
    rule.matchTier ? `tier is ${rule.matchTier}` : null,
  ].filter(Boolean);

  const then = [
    rule.setTier ? `tier ${rule.setTier}` : null,
    rule.setModelId ? `model ${rule.setModelId}` : null,
    rule.setNodeId ? "a specific machine" : null,
  ].filter(Boolean);

  return `${when.length ? when.join(" and ") : "always"} → ${then.join(", ")}`;
}
