import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type ModelList, type Provider } from "../../lib/api";

/* Named, ordered fallback chains of models — "difficult programming",
 * "tester", "decision maker" — with a short description of when each applies.
 *
 * Not the tier system on the Providers tab: a tier is a coarse, automatic
 * guess from a model's name, used for routing rules and defaults. A list here
 * is curated by hand and named for a purpose rather than a size, and the
 * description is written for whatever ends up choosing a model per task to
 * read — not for a human skimming this page. Entries are tried in order until
 * one is available. */

export function ModelsPanel({ providers, ownerLabel }: { providers: Provider[]; ownerLabel: string }) {
  const [lists, setLists] = useState<ModelList[]>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const availableModels = providers.flatMap((p) =>
    p.models.filter((m) => m.probeOk !== false).map((m) => m.modelId),
  );

  async function refresh() {
    try {
      setLists((await api.modelLists()).lists);
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load model lists.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-[12.5px] text-tertiary leading-[1.55] flex-1 min-w-[220px]">
          Ordered fallback chains for a kind of work, each with a description of when to use it. Owned
          by {ownerLabel}, and meant to be read by whatever decides which model a task gets.
        </p>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(!creating)}>
          {creating ? "Cancel" : "New list"}
        </button>
      </div>

      {creating && (
        <CreateList
          onCreated={() => {
            setCreating(false);
            void refresh();
          }}
        />
      )}

      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}

      {lists && lists.length === 0 && !creating && (
        <p className="text-[13px] text-faint">
          No lists yet. "Difficult programming", "tester", "decision maker" — whatever categories the
          work actually falls into here.
        </p>
      )}

      {lists?.map((list) => (
        <ListCard
          key={list.id}
          list={list}
          availableModels={availableModels}
          onChanged={() => void refresh()}
        />
      ))}
    </div>
  );
}

function CreateList({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.createModelList(name.trim(), description.trim() || null);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-2 border rule rounded-lg px-3 py-3 bg-surface" onSubmit={submit}>
      <Field label="Name">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="difficult programming"
          required
          autoFocus
        />
      </Field>
      <Field label="When to use it" hint="Written for whatever reads this list, not just for you.">
        <input
          className={inputClass}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Hard, novel problems that need real reasoning — refactors, unfamiliar codebases, ambiguous specs."
        />
      </Field>
      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}
      <button type="submit" className="btn btn-primary self-start" disabled={busy || !name.trim()}>
        {busy ? "Creating…" : "Create"}
      </button>
    </form>
  );
}

function ListCard({
  list,
  availableModels,
  onChanged,
}: {
  list: ModelList;
  availableModels: string[];
  onChanged: () => void;
}) {
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState(list.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const already = new Set(list.entries.map((e) => e.modelId));
  const choices = availableModels.filter((m) => !already.has(m));

  async function add(modelId: string) {
    setBusy(true);
    setError(undefined);
    try {
      await api.addModelListEntry(list.id, modelId);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add it.");
    } finally {
      setBusy(false);
    }
  }

  async function saveDescription() {
    const next = description.trim();
    if (next === (list.description ?? "")) {
      setEditingDescription(false);
      return;
    }
    await api.updateModelList(list.id, { description: next || null });
    setEditingDescription(false);
    onChanged();
  }

  async function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= list.entries.length) return;
    const order = list.entries.map((e) => e.id);
    [order[index], order[target]] = [order[target]!, order[index]!];
    await api.reorderModelList(list.id, order);
    onChanged();
  }

  return (
    <div className="flex flex-col gap-2.5 border rule rounded-lg px-3 py-2.5 bg-raised">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="text-[13px] font-medium">{list.name}</span>
        <span className="font-mono text-[10.5px] text-tertiary tnum">
          {list.entries.length} model{list.entries.length === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-chip"
          onClick={async () => {
            await api.deleteModelList(list.id);
            onChanged();
          }}
        >
          Delete
        </button>
      </div>

      {editingDescription ? (
        <input
          autoFocus
          className={inputClass}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={saveDescription}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDescription(list.description ?? "");
              setEditingDescription(false);
            }
          }}
          placeholder="When to use it"
        />
      ) : (
        <button
          type="button"
          className="text-left text-[12.5px] text-tertiary leading-snug hover:text-secondary"
          onClick={() => setEditingDescription(true)}
          title="Click to edit"
        >
          {list.description || <span className="text-faint italic">No description — click to add one.</span>}
        </button>
      )}

      {list.entries.length === 0 ? (
        <p className="text-[12px] text-faint">Nothing in this list yet.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {list.entries.map((entry, i) => (
            <li
              key={entry.id}
              className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-surface"
            >
              <span className="font-mono text-[10px] text-faint tnum w-4 text-right flex-none">
                {i + 1}
              </span>
              <span className="font-mono text-[11.5px] text-secondary truncate flex-1">
                {entry.modelId}
              </span>
              <button
                type="button"
                className="btn btn-chip"
                disabled={i === 0}
                onClick={() => void move(i, -1)}
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn-chip"
                disabled={i === list.entries.length - 1}
                onClick={() => void move(i, 1)}
                aria-label="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                className="btn btn-chip"
                onClick={async () => {
                  await api.removeModelListEntry(list.id, entry.id);
                  onChanged();
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}

      {choices.length > 0 && (
        <ModelSearchSelect choices={choices} busy={busy} onAdd={(modelId) => void add(modelId)} />
      )}

      {error && <div className="text-[11.5px] text-bad-hi">{error}</div>}
    </div>
  );
}

/* A searchable picker for a list that can run to hundreds of model ids — a
 * plain <select> makes anyone scroll a wall of dated variants to find one.
 * Typing filters; Enter or a click adds and clears the field immediately,
 * rather than requiring a separate confirm — there is nothing to confirm,
 * since removing a mis-added entry is one click away. */
function ModelSearchSelect({
  choices,
  busy,
  onAdd,
}: {
  choices: string[];
  busy: boolean;
  onAdd: (modelId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const matches = (q ? choices.filter((c) => c.toLowerCase().includes(q)) : choices).slice(0, 50);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  function pick(modelId: string) {
    onAdd(modelId);
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="relative" ref={rootRef}>
      <input
        className={inputClass}
        value={query}
        disabled={busy}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const picked = matches[highlight];
            if (picked) pick(picked);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={busy ? "Adding…" : `Search ${choices.length} models to add…`}
      />

      {open && matches.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[260px] overflow-auto scroll-quiet rounded-lg border rule-default bg-surface shadow-lg">
          {matches.map((modelId, i) => (
            <button
              key={modelId}
              type="button"
              className={`w-full text-left px-2.5 py-1.5 font-mono text-[11.5px] truncate ${
                i === highlight ? "bg-hover text-primary" : "text-secondary"
              }`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                /* mousedown, not click: fires before the input's blur, so the
                   outside-click handler above never gets a chance to close
                   this first and swallow the selection. */
                e.preventDefault();
                pick(modelId);
              }}
            >
              {modelId}
            </button>
          ))}
        </div>
      )}

      {open && q && matches.length === 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border rule-default bg-surface shadow-lg px-2.5 py-1.5 text-[11.5px] text-faint">
          No matches.
        </div>
      )}
    </div>
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
