import { useState, type FormEvent } from "react";
import { api, ApiError, type Provider } from "../../lib/api";

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
        const usable = provider.models.filter((m) => m.probeOk !== false).length;
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
              <button
                type="button"
                className="btn btn-chip"
                disabled={busy === provider.id}
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
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-faint">
                  models and tiers
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

              {provider.models.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-surface"
                  title={model.probeError ?? undefined}
                >
                  <span
                    className={`font-mono text-[11px] flex-1 truncate ${
                      model.probeOk === false ? "text-faint line-through" : "text-secondary"
                    }`}
                  >
                    {model.modelId}
                  </span>

                  {model.tierSource === "manual" && (
                    <span className="font-mono text-[9px] text-accent-hi">set by hand</span>
                  )}

                  <select
                    value={model.tier}
                    onChange={async (e) => {
                      await api.setModelTier(provider.id, model.modelId, e.target.value);
                      onChanged();
                    }}
                    className="bg-surface border rule rounded px-1.5 py-0.5 font-mono text-[10.5px] text-secondary outline-none"
                  >
                    <option value="light">light</option>
                    <option value="standard">standard</option>
                    <option value="heavy">heavy</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
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
