import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type GatewayService, type McpServer } from "../../lib/api";

/* MCP servers.
 *
 * Owned by whoever you are working as — your account, or the organization in
 * the switcher. A connection to GitHub is a fact about the team rather than
 * about one repository, so it is configured once and every project can use it. */

export function McpPanel({ ownerLabel }: { ownerLabel: string }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();

  async function refresh() {
    try {
      setServers((await api.mcpServers()).servers);
      setError(undefined);
    } catch {
      setError("Could not load MCP servers.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-[12.5px] text-tertiary leading-[1.55] flex-1 min-w-[220px]">
          External tools an agent can use, over the Model Context Protocol. Available to every
          project owned by {ownerLabel}.
        </p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setImporting(!importing);
            setAdding(false);
          }}
        >
          {importing ? "Cancel" : "Add from a gateway"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            setAdding(!adding);
            setImporting(false);
          }}
        >
          {adding ? "Cancel" : "Connect a server"}
        </button>
      </div>

      {importing && (
        <ImportGateway
          onImported={(close) => {
            if (close) setImporting(false);
            void refresh();
          }}
        />
      )}

      {adding && (
        <AddServer
          onAdded={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}

      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}

      {servers.length === 0 && !adding && (
        <p className="text-[13px] text-faint">Nothing connected yet.</p>
      )}

      {servers.map((server) => (
        <ServerRow key={server.id} server={server} onChanged={() => void refresh()} />
      ))}
    </div>
  );
}

function ServerRow({ server, onChanged }: { server: McpServer; onChanged: () => void }) {
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>();
  const [busy, setBusy] = useState(false);
  const [probeError, setProbeError] = useState<string>();

  const allowlist = new Set(server.toolAllowlist);

  async function loadTools() {
    setBusy(true);
    setProbeError(undefined);
    try {
      const result = await api.mcpTools(server.id);
      setTools(result.tools);
      if (result.tools.length === 0 && result.note) setProbeError(result.note);
    } catch (err) {
      setProbeError(err instanceof ApiError ? err.message : "Could not reach it.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleTool(name: string) {
    /* An empty allowlist means "everything", so the first exclusion has to
       start from the full list rather than from nothing. */
    const base = allowlist.size === 0 ? new Set((tools ?? []).map((t) => t.name)) : new Set(allowlist);
    if (base.has(name)) base.delete(name);
    else base.add(name);

    await api.updateMcpServer(server.id, { toolAllowlist: [...base] });
    onChanged();
  }

  return (
    <div className="flex flex-col gap-2 border rule rounded-lg px-3 py-2.5 bg-raised">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span
          className={
            !server.enabled
              ? "dot dot-idle"
              : server.lastError
                ? "dot dot-off"
                : server.lastConnectedAt
                  ? "dot dot-done"
                  : "dot dot-idle"
          }
        />
        <span className="text-[13px] font-medium">{server.name}</span>
        <span className="font-mono text-[10px] text-faint">
          {server.placement === "node" ? "on the node" : "on the server"}
        </span>
        <span className="font-mono text-[10.5px] text-faint truncate max-w-[260px]">
          {server.url ?? `${server.command} ${(server.args ?? []).join(" ")}`}
        </span>
        <DescriptionField server={server} onChanged={onChanged} />
        <span className="flex-1" />

        <label className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-faint">approval</span>
          <select
            value={server.approval}
            onChange={async (e) => {
              await api.updateMcpServer(server.id, { approval: e.target.value });
              onChanged();
            }}
            className="bg-surface border rule rounded px-1.5 py-0.5 font-mono text-[10.5px] text-secondary outline-none"
          >
            <option value="auto">auto</option>
            <option value="ask">ask</option>
            <option value="never">never</option>
          </select>
        </label>

        <button
          type="button"
          className="btn btn-chip"
          onClick={async () => {
            await api.updateMcpServer(server.id, { enabled: !server.enabled });
            onChanged();
          }}
        >
          {server.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          className="btn btn-chip"
          onClick={async () => {
            await api.deleteMcpServer(server.id);
            onChanged();
          }}
        >
          Remove
        </button>
      </div>

      {server.lastError && (
        <div className="text-[11.5px] text-bad-hi bg-inset border rule rounded px-2 py-1.5">
          Last attempt failed: {server.lastError}
        </div>
      )}

      {server.placement === "node" && (
        <div className="text-[11.5px] text-warn-hi">
          Node-side servers are stored but not started yet, so this contributes no tools.
        </div>
      )}

      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-chip" onClick={loadTools} disabled={busy}>
          {busy ? "Asking…" : tools ? "Refresh tools" : "Show tools"}
        </button>
        <span className="font-mono text-[10.5px] text-faint">
          {allowlist.size === 0 ? "all tools enabled" : `${allowlist.size} enabled`}
        </span>
      </div>

      {probeError && <div className="text-[11.5px] text-warn-hi">{probeError}</div>}

      {/* The picker exists because a server can advertise forty tools and a
          project rarely wants all forty in context. */}
      {tools && tools.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {tools.map((tool) => {
            const on = allowlist.size === 0 || allowlist.has(tool.name);
            return (
              <label
                key={tool.name}
                className="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-surface cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => void toggleTool(tool.name)}
                  className="mt-[3px]"
                />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="font-mono text-[11px] text-secondary">
                    {server.name}__{tool.name}
                  </span>
                  <span className="text-[11.5px] text-faint leading-snug">{tool.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* What a model chooses this server by, editable in place — the same
   click-to-edit idiom a node's name uses. Blank reads as "(no description)"
   in the row and simply sends nothing extra to the model's prompt, rather
   than an empty line. */
function DescriptionField({
  server,
  onChanged,
}: {
  server: McpServer;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(server.description ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    const next = value.trim();
    if (next === (server.description ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await api.updateMcpServer(server.id, { description: next });
      onChanged();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setValue(server.description ?? "");
            setEditing(false);
          }
        }}
        placeholder="What it's for"
        className="text-[12px] text-primary bg-canvas border rule-default rounded px-1.5 py-0.5 outline-none focus:border-[var(--border-accent)] w-[220px]"
      />
    );
  }

  return (
    <button
      type="button"
      className="text-[12px] text-tertiary hover:text-primary hover:underline decoration-dotted underline-offset-2 truncate max-w-[220px] text-left"
      onClick={() => setEditing(true)}
      title="Click to edit — shown to the model instead of this server's tool list."
    >
      {server.description || "(no description)"}
    </button>
  );
}

/* Importing from a gateway.
 *
 * One host, one key, several MCP services. Discovery is a separate step from
 * import so the key can be tried and the list read before anything is stored —
 * a gateway you decide against leaves nothing behind. Each service imported
 * becomes an ordinary server row, so nothing downstream treats it specially. */
function ImportGateway({ onImported }: { onImported: (close: boolean) => void }) {
  const [baseUrl, setBaseUrl] = useState("https://mcp.dury.dev");
  const [token, setToken] = useState("");
  const [approval, setApproval] = useState("ask");
  const [services, setServices] = useState<GatewayService[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ added: string[]; skipped: Array<{ id: string; reason: string }> }>();

  async function discover(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const found = await api.discoverGateway(baseUrl, token);
      setServices(found.services);
      /* Everything usable is pre-ticked: importing all of them is the common
         case, and a service that is not ready would only fail later. */
      setPicked(
        new Set(
          found.services.filter((s) => !s.alreadyAdded && s.connected).map((s) => s.id),
        ),
      );
    } catch (err) {
      setServices(undefined);
      setError(err instanceof ApiError ? err.message : "Could not reach that gateway.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await api.importGateway({
        baseUrl,
        token,
        serviceIds: [...picked],
        approval,
      });
      setResult(outcome);
      /* The form stays open when anything was skipped, because the reason is
         the only place that says why — closing it would take the answer away
         at the moment it is needed. */
      onImported(outcome.skipped.length === 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not import them.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-2 border rule rounded-lg px-3 py-3 bg-surface" onSubmit={discover}>
      <p className="text-[12.5px] text-tertiary leading-[1.55]">
        A gateway hosts several MCP services behind one key. Each one you pick is connected
        separately, so you can enable, disable and scope them independently afterwards.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Field label="Gateway URL">
          <input
            className={inputClass}
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setServices(undefined);
            }}
            placeholder="https://mcp.dury.dev"
            required
          />
        </Field>
        <Field label="API key" hint="Encrypted at rest. It is never shown again.">
          <input
            className={inputClass}
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setServices(undefined);
            }}
            autoComplete="off"
            placeholder="imcp_…"
            required
          />
        </Field>
      </div>

      {!services && (
        <button type="submit" className="btn btn-primary self-start" disabled={busy}>
          {busy ? "Asking the gateway…" : "See what it hosts"}
        </button>
      )}

      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}

      {services && services.length === 0 && (
        <div className="text-[12.5px] text-warn-hi">
          That key reaches no services. Check its scope on the gateway.
        </div>
      )}

      {services && services.length > 0 && (
        <>
          <div className="flex flex-col gap-0.5">
            {services.map((service) => {
              const usable = !service.alreadyAdded;
              return (
                <label
                  key={service.id}
                  className={`flex items-start gap-2 rounded px-1.5 py-1 ${
                    usable ? "hover:bg-raised cursor-pointer" : "opacity-55"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-[3px]"
                    disabled={!usable}
                    checked={picked.has(service.id)}
                    onChange={() => {
                      const next = new Set(picked);
                      if (next.has(service.id)) next.delete(service.id);
                      else next.add(service.id);
                      setPicked(next);
                    }}
                  />
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-mono text-[11px] text-secondary">{service.id}</span>
                      <span className="text-[12px] text-tertiary">{service.name}</span>
                      {service.alreadyAdded && (
                        <span className="font-mono text-[9.5px] text-faint">already connected</span>
                      )}
                      {!service.connected && (
                        <span className="font-mono text-[9.5px] text-warn-hi">
                          needs an account linked at the gateway
                        </span>
                      )}
                    </span>
                    {service.description && (
                      <span className="text-[11.5px] text-faint leading-snug">
                        {service.description}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>

          <Field label="Approval" hint="Applies to every service imported now. Change it per server afterwards.">
            <select
              className={inputClass}
              value={approval}
              onChange={(e) => setApproval(e.target.value)}
            >
              <option value="ask">Ask before every call</option>
              <option value="auto">Run without asking</option>
              <option value="never">Never run</option>
            </select>
          </Field>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || picked.size === 0}
              onClick={() => void submit()}
            >
              {busy
                ? "Connecting…"
                : `Connect ${picked.size} service${picked.size === 1 ? "" : "s"}`}
            </button>
            <button type="submit" className="btn" disabled={busy}>
              Re-check
            </button>
          </div>
        </>
      )}

      {result && (
        <div className="flex flex-col gap-1 text-[12px]">
          {result.added.length > 0 && (
            <div className="text-add-hi">Connected {result.added.join(", ")}.</div>
          )}
          {result.skipped.map((s) => (
            <div key={s.id} className="text-warn-hi">
              {s.id}: {s.reason}
            </div>
          ))}
        </div>
      )}
    </form>
  );
}

function AddServer({ onAdded }: { onAdded: () => void }) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    placement: "server" as "server" | "node",
    url: "",
    command: "",
    args: "",
    headerName: "",
    headerValue: "",
    approval: "ask" as "auto" | "ask" | "never",
  });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.addMcpServer({
        name: form.name,
        description: form.description || undefined,
        placement: form.placement,
        approval: form.approval,
        ...(form.placement === "server"
          ? {
              url: form.url,
              ...(form.headerName
                ? { headers: { [form.headerName]: form.headerValue } }
                : {}),
            }
          : {
              command: form.command,
              args: form.args.split(/\s+/).filter(Boolean),
            }),
      });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not connect it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-2 border rule rounded-lg px-3 py-3 bg-surface" onSubmit={submit}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Field label="Name" hint="Becomes the tool prefix, e.g. github__create_issue">
          <input
            className={inputClass}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="github"
            required
          />
        </Field>
        {/* What a model chooses this server by: it is shown one line per
            server rather than every tool on it, so this is the whole pitch —
            "IP, websites and domains" is what makes it open web_tools. */}
        <Field label="What it's for" hint="Shown to the model instead of its tool list, until it asks to see one.">
          <input
            className={inputClass}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="IP, websites and domains"
          />
        </Field>
        <Field label="Where it runs">
          <select
            className={inputClass}
            value={form.placement}
            onChange={(e) => setForm({ ...form, placement: e.target.value as "server" | "node" })}
          >
            <option value="server">On the Maestro server — remote HTTP</option>
            <option value="node">On the node — a local process</option>
          </select>
        </Field>
      </div>

      {form.placement === "server" ? (
        <>
          <Field label="URL">
            <input
              className={inputClass}
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://api.example.com/mcp/"
              required
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label="Auth header name" hint="Optional">
              <input
                className={inputClass}
                value={form.headerName}
                onChange={(e) => setForm({ ...form, headerName: e.target.value })}
                placeholder="Authorization"
              />
            </Field>
            <Field label="Value" hint="Encrypted at rest, never shown again">
              <input
                className={inputClass}
                type="password"
                value={form.headerValue}
                onChange={(e) => setForm({ ...form, headerValue: e.target.value })}
                autoComplete="off"
              />
            </Field>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Field label="Command">
            <input
              className={inputClass}
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
              placeholder="npx"
              required
            />
          </Field>
          <Field label="Arguments">
            <input
              className={inputClass}
              value={form.args}
              onChange={(e) => setForm({ ...form, args: e.target.value })}
              placeholder="-y @modelcontextprotocol/server-postgres"
            />
          </Field>
        </div>
      )}

      <Field label="Approval" hint="Ask is the safe default: tools stop and wait for you.">
        <select
          className={inputClass}
          value={form.approval}
          onChange={(e) => setForm({ ...form, approval: e.target.value as never })}
        >
          <option value="ask">Ask before every call</option>
          <option value="auto">Run without asking</option>
          <option value="never">Never run</option>
        </select>
      </Field>

      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}

      <button type="submit" className="btn btn-primary self-start" disabled={busy}>
        {busy ? "Connecting…" : "Connect"}
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
