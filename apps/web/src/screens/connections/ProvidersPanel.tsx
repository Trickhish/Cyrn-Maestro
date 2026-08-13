import { useState, type FormEvent } from "react";
import { api, ApiError, type Provider, type ProviderModel } from "../../lib/api";

/* Where model inference comes from, and how each model is classified.
 *
 * The tier is guessed from the model's name on arrival and corrected here. A
 * refresh re-runs the guess only for models still carrying one, so a correction
 * survives — otherwise every refresh would silently undo it. */

export function ProvidersPanel({
  providers,
  onChanged,
}: {
  providers: Provider[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <p className="text-[12.5px] text-tertiary leading-[1.55] flex-1">
          Sources of model inference. Keys are encrypted and never leave the server.
        </p>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(!adding)}>
          {adding ? "Cancel" : "Add provider"}
        </button>
      </div>

      {adding && <AddProvider onAdded={() => { setAdding(false); onChanged(); }} />}

      {providers.length === 0 && !adding && (
        <div className="text-[13px] text-faint">
          No provider connected. Tasks cannot run without one.
        </div>
      )}

      {providers.map((provider) => {
        const usable = provider.models.filter((m) => m.enabled && m.probeOk !== false).length;
        /* Counted because it is the difference between a spend cap that works
           and one that is decorative. */
        const unpriced = provider.models.filter(
          (m) => m.enabled && m.probeOk !== false && m.priceInPerMTok == null && m.priceOutPerMTok == null,
        ).length;
        return (
          <div key={provider.id} className="flex flex-col gap-2 border rule rounded-lg px-3 py-2.5 bg-raised">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className={provider.lastHealthOk === false ? "dot dot-off" : "dot dot-done"} />
              <span className="text-[13px] font-medium">{provider.name}</span>
              <span className="font-mono text-[10.5px] text-faint truncate">{provider.baseUrl}</span>
              <span className="flex-1" />
              <span className="font-mono text-[10.5px] text-tertiary tnum">
                {usable}/{provider.models.length} usable
              </span>
              {unpriced > 0 && (
                <span
                  className="font-mono text-[10.5px] text-warn-hi tnum"
                  title="An unpriced model records no cost, so spend caps cannot see it."
                >
                  {unpriced} unpriced
                </span>
              )}
              <button
                type="button"
                className="btn btn-chip"
                disabled={Boolean(busy)}
                title="Re-read the model list, and probe a sample of it."
                onClick={async () => {
                  setBusy(provider.id);
                  try {
                    await api.refreshProvider(provider.id);
                    onChanged();
                  } finally {
                    setBusy(undefined);
                  }
                }}
              >
                {busy === provider.id ? "Probing…" : "Refresh"}
              </button>
              <TestAll provider={provider} busy={Boolean(busy)} setBusy={setBusy} onChanged={onChanged} />
              <RemoveProvider providerId={provider.id} onRemoved={onChanged} />
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-faint">
                  models, tiers and prices
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  className="btn btn-chip"
                  onClick={async () => {
                    await api.reclassifyModels(provider.id);
                    onChanged();
                  }}
                >
                  Reset to automatic
                </button>
              </div>

              <BulkDisable providerId={provider.id} models={provider.models} onChanged={onChanged} />

              {groupByOwner(provider.models).map(([owner, models]) => (
                <OwnerDrawer
                  key={owner}
                  providerId={provider.id}
                  owner={owner}
                  models={models}
                  onChanged={onChanged}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* A proxy that re-publishes the same handful of underlying models under many
 * routing aliases — "auto/", "no-think/", vendor-specific prefixes — can
 * dump hundreds of variants into one provider's list. Disabling a model here
 * is respected everywhere the router picks one (index.ts and gateway.ts both
 * filter on `models.enabled`), independent of anything the upstream proxy
 * itself lets you turn off — so this works regardless of what that proxy's
 * own dashboard exposes. Matching by substring rather than a real pattern
 * language: a prefix typed in plain text is what the case actually calls
 * for, and a full pattern syntax would be a feature nobody asked for yet. */
function BulkDisable({
  providerId,
  models,
  onChanged,
}: {
  providerId: string;
  models: ProviderModel[];
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const q = query.trim().toLowerCase();
  const matches = q ? models.filter((m) => m.enabled && m.modelId.toLowerCase().includes(q)) : [];

  async function apply() {
    setBusy(true);
    try {
      await Promise.all(matches.map((m) => api.setModelEnabled(providerId, m.modelId, false)));
      setQuery("");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 pb-1">
      <input
        className="flex-1 bg-canvas border rule-default rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--border-accent)]"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder='Disable models containing… e.g. "auto/" or "no-think/"'
      />
      <button
        type="button"
        className="btn btn-chip flex-none"
        disabled={!matches.length || busy}
        onClick={apply}
      >
        {busy ? "Disabling…" : q ? `Disable ${matches.length}` : "Disable matching"}
      </button>
    </div>
  );
}

/* Removing a provider is more consequential than the other removals on this
 * tab: the key has no read path back out once it is in — "encrypted, and the
 * gateway decrypts in-process at call time only" — so undoing a mistaken
 * removal means going and copying the key again from wherever it lives, not
 * just re-adding a row. A plain one-click button reads the same for this as
 * for revoking a node, which is free to redo; a second click to confirm
 * costs one extra tap and buys back the moment to notice the wrong row. */
function RemoveProvider({ providerId, onRemoved }: { providerId: string; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!confirming) {
    return (
      <button type="button" className="btn btn-chip" onClick={() => setConfirming(true)}>
        Remove
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        className="btn btn-chip btn-warn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.deleteProvider(providerId);
            onRemoved();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Removing…" : "Confirm remove?"}
      </button>
      <button type="button" className="btn btn-chip" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}

/* One model: its tier, and what it costs.
 *
 * Prices are editable because the built-in table is published list pricing and
 * will drift, and because whoever pays the bill knows their own rate — a
 * negotiated contract, a self-hosted model that costs nothing per token, a
 * proxy that marks up. An unpriced model is called out rather than shown as
 * free, since it records no cost and therefore slips past every spend cap. */
function ModelRow({
  providerId,
  model,
  onChanged,
}: {
  providerId: string;
  model: ProviderModel;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const unpriced = model.priceInPerMTok == null && model.priceOutPerMTok == null;

  async function savePrice(inPrice: string, outPrice: string) {
    const parse = (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const value = Number(trimmed);
      return Number.isFinite(value) && value >= 0 ? value : null;
    };
    await api.setModelPrice(providerId, model.modelId, {
      priceInPerMTok: parse(inPrice),
      priceOutPerMTok: parse(outPrice),
    });
    setEditing(false);
    onChanged();
  }

  return (
    <div className={`flex flex-col gap-1 rounded px-1.5 py-1 hover:bg-surface ${model.enabled ? "" : "opacity-50"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`font-mono text-[11px] flex-1 min-w-[140px] truncate ${
            !model.enabled || model.probeOk === false ? "text-faint line-through" : "text-secondary"
          }`}
          title={model.probeError ?? undefined}
        >
          {model.modelId}
        </span>

        {model.tierSource === "manual" && (
          <span className="font-mono text-[9px] text-accent-hi">tier by hand</span>
        )}

        <button
          type="button"
          className={`font-mono text-[10px] tnum px-1.5 py-0.5 rounded hover:bg-raised ${
            unpriced ? "text-warn-hi" : "text-faint"
          }`}
          onClick={() => setEditing(!editing)}
          title={
            unpriced
              ? "No price, so this model records no cost and spend caps cannot see it. Click to set one."
              : `${model.priceSource === "manual" ? "Set by hand" : "Published list price"}. Click to change.`
          }
        >
          {unpriced
            ? "unpriced"
            : `$${fmt(model.priceInPerMTok)} / $${fmt(model.priceOutPerMTok)}`}
        </button>

        <select
          value={model.tier}
          onChange={async (e) => {
            await api.setModelTier(providerId, model.modelId, e.target.value);
            onChanged();
          }}
          className="bg-surface border rule rounded px-1.5 py-0.5 font-mono text-[10.5px] text-secondary outline-none"
        >
          <option value="light">light</option>
          <option value="standard">standard</option>
          <option value="heavy">heavy</option>
        </select>

        <button
          type="button"
          className="btn btn-chip"
          onClick={async () => {
            await api.setModelEnabled(providerId, model.modelId, !model.enabled);
            onChanged();
          }}
        >
          {model.enabled ? "Disable" : "Enable"}
        </button>
      </div>

      {editing && <PriceEditor model={model} onSave={savePrice} onCancel={() => setEditing(false)} />}
    </div>
  );
}

function PriceEditor({
  model,
  onSave,
  onCancel,
}: {
  model: ProviderModel;
  onSave: (inPrice: string, outPrice: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [inPrice, setInPrice] = useState(model.priceInPerMTok?.toString() ?? "");
  const [outPrice, setOutPrice] = useState(model.priceOutPerMTok?.toString() ?? "");
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex flex-wrap items-end gap-2 border-l-2 border-[var(--border-accent)] pl-2.5 py-1">
      <label className="flex flex-col gap-0.5">
        <span className="font-mono text-[9px] tracking-[0.1em] uppercase text-faint">
          input $/M
        </span>
        <input
          className="w-[92px] bg-canvas border rule-default rounded px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--border-accent)]"
          value={inPrice}
          inputMode="decimal"
          placeholder="unpriced"
          onChange={(e) => setInPrice(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="font-mono text-[9px] tracking-[0.1em] uppercase text-faint">
          output $/M
        </span>
        <input
          className="w-[92px] bg-canvas border rule-default rounded px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--border-accent)]"
          value={outPrice}
          inputMode="decimal"
          placeholder="unpriced"
          onChange={(e) => setOutPrice(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="btn btn-chip"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onSave(inPrice, outPrice);
          } finally {
            setBusy(false);
          }
        }}
      >
        Save
      </button>
      <button type="button" className="btn btn-chip" onClick={onCancel}>
        Cancel
      </button>
      <span className="text-[10.5px] text-faint leading-snug">
        USD per million tokens. Leave blank for unpriced.
      </span>
    </div>
  );
}

/* Sub-dollar prices need more than two places, whole ones need fewer. */
function fmt(value: number | null): string {
  if (value == null) return "—";
  if (value === 0) return "0";
  return value < 1 ? value.toFixed(2).replace(/0$/, "") : String(value);
}

function AddProvider({ onAdded }: { onAdded: () => void }) {
  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
    apiKey: "",
  });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { provider } = await api.addProvider({
        name: form.name,
        kind: "openai_compatible",
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
      });
      /* Probing here rather than making it a second manual step: a provider
         whose model list has never been fetched offers nothing to route to. */
      await api.refreshProvider(provider.id).catch(() => {});
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-2 border rule rounded-lg px-3 py-3 bg-surface" onSubmit={submit}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Field label="Name">
          <input
            className={inputClass}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="CLIProxyAPI"
            required
          />
        </Field>
        <Field label="Base URL" hint="Ends in /v1">
          <input
            className={inputClass}
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            placeholder="https://example.com/v1"
            required
          />
        </Field>
      </div>
      <Field label="API key" hint="Encrypted at rest. It is never shown again.">
        <input
          className={inputClass}
          type="password"
          value={form.apiKey}
          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          autoComplete="off"
          required
        />
      </Field>
      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}
      <button type="submit" className="btn btn-primary self-start" disabled={busy}>
        {busy ? "Connecting and probing…" : "Add and probe"}
      </button>
    </form>
  );
}

const inputClass =
  "w-full bg-canvas border rule-default rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--border-accent)]";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-faint">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint leading-snug">{hint}</span>}
    </label>
  );
}

/* One connection to a proxy can front a dozen upstreams, and 379 models in one
   flat list is not a list anyone reads. `owned_by` is the grouping the gateway
   already gives us, and it is the one that matters operationally: upstreams
   lose their credentials, rate-limit and cost independently of each other. */
const UNGROUPED = "other";

function groupByOwner(models: ProviderModel[]): Array<[string, ProviderModel[]]> {
  const groups = new Map<string, ProviderModel[]>();
  for (const model of models) {
    const owner = model.ownedBy || UNGROUPED;
    groups.set(owner, [...(groups.get(owner) ?? []), model]);
  }

  /* Biggest first, with the ungrouped remainder last however big it is —
     "other" is where you look when the answer is not in a real group. */
  return [...groups.entries()].sort(([a, ma], [b, mb]) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return mb.length - ma.length || a.localeCompare(b);
  });
}

function OwnerDrawer({
  providerId,
  owner,
  models,
  onChanged,
}: {
  providerId: string;
  owner: string;
  models: ProviderModel[];
  onChanged: () => void;
}) {
  /* Closed by default: the point of grouping several hundred models is that
     you open the one you care about, not that you scroll past all of them. */
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const enabled = models.filter((m) => m.enabled).length;
  const broken = models.filter((m) => m.probeOk === false).length;
  const allOff = enabled === 0;

  return (
    <div className="border rule rounded-lg bg-surface overflow-hidden">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          onClick={() => setOpen(!open)}
        >
          <span className="text-faint text-[9px] w-2">{open ? "▾" : "▸"}</span>
          <span className={`font-mono text-[12px] truncate ${allOff ? "text-faint" : "text-primary"}`}>
            {owner}
          </span>
          <span className="font-mono text-[10.5px] text-tertiary tnum flex-none">
            {enabled}/{models.length}
          </span>
          {/* Surfaced on the closed drawer, since a dead upstream is the whole
              reason someone comes looking. */}
          {broken > 0 && (
            <span className="font-mono text-[10px] text-warn-hi flex-none">{broken} failing</span>
          )}
        </button>

        <button
          type="button"
          className="btn btn-chip"
          disabled={busy}
          title={
            allOff
              ? `Re-enable all ${models.length} models from ${owner}.`
              : `Disable all ${models.length} models from ${owner} — the rest of this connection keeps working.`
          }
          onClick={async () => {
            setBusy(true);
            try {
              await api.setOwnerEnabled(providerId, owner, allOff);
              onChanged();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "…" : allOff ? "Enable all" : "Disable all"}
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-1 px-3 pb-3">
          {models.map((model) => (
            <ModelRow key={model.id} providerId={providerId} model={model} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

/* Probe every model, not the sample a normal refresh takes.
 *
 * A refresh caps probing deliberately: one real API call per model is fine for
 * twenty and absurd for several hundred. But the cap leaves most of a large
 * catalogue carrying no verdict at all, which is exactly the state that let a
 * whole dead upstream look fine — so there has to be a way to ask properly,
 * and it belongs on a button someone presses rather than a default.
 *
 * Confirmed first because the cost is real and proportional to the catalogue:
 * one call per model, and on a 379-model gateway that is minutes of waiting
 * and 379 billable requests. The count is in the button so nobody has to
 * guess how big "all" is. */
function TestAll({
  provider,
  busy,
  setBusy,
  onChanged,
}: {
  provider: Provider;
  busy: boolean;
  setBusy: (id: string | undefined) => void;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string>();
  const [running, setRunning] = useState(false);

  if (running) {
    return (
      <span className="font-mono text-[10.5px] text-accent-hi">
        Testing {provider.models.length}…
      </span>
    );
  }

  if (result) {
    return (
      <button
        type="button"
        className="font-mono text-[10.5px] text-tertiary hover:text-primary"
        title="Click to dismiss"
        onClick={() => setResult(undefined)}
      >
        {result}
      </button>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="btn btn-chip"
        disabled={busy}
        title={`Probe all ${provider.models.length} models — one API call each, so this takes a while.`}
        onClick={() => setConfirming(true)}
      >
        Test all
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        className="btn btn-chip btn-warn"
        disabled={busy}
        onClick={async () => {
          setConfirming(false);
          setRunning(true);
          setBusy(provider.id);
          try {
            const r = await api.refreshProvider(provider.id, "all");
            setResult(`${r.usable}/${r.count} usable`);
            onChanged();
          } catch (err) {
            setResult(err instanceof ApiError ? err.message : "Testing failed");
          } finally {
            setRunning(false);
            setBusy(undefined);
          }
        }}
      >
        Test {provider.models.length}?
      </button>
      <button type="button" className="btn btn-chip" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}
