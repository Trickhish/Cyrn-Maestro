import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";

/* Instance settings — visible only to an instance administrator.
 *
 * About running the server rather than the work inside it: how mail leaves the
 * machine, and who may create an account. Organization settings live elsewhere,
 * under the organization that owns them. */

interface Settings {
  smtp: {
    host: string;
    port: string;
    security: "tls" | "starttls" | "none";
    username: string;
    passwordSet: boolean;
    fromAddress: string;
    fromName: string;
  };
  registration: { open: boolean; allowedDomain: string };
}

export function InstanceSettings({ email }: { email: string }) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .instanceSettings()
      .then(setSettings)
      .catch(() => setError("Only an instance administrator can open this page."));
  }, []);

  if (error) {
    return (
      <section className="flex-1 grid place-items-center bg-canvas">
        <p className="text-[13px] text-faint">{error}</p>
      </section>
    );
  }

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-canvas overflow-auto scroll-quiet">
      <header className="h-[46px] flex-none flex items-center gap-3 px-[26px] border-b rule sticky top-0 bg-canvas z-10">
        <h1 className="font-display text-[14px] font-semibold">Instance settings</h1>
        <span className="text-[12.5px] text-tertiary">everyone on this server</span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-faint">instance admin</span>
      </header>

      {settings && (
        <div className="px-[26px] py-6 flex flex-col gap-8 max-w-[620px]">
          <SmtpForm settings={settings} onSaved={setSettings} adminEmail={email} />
          <RegistrationForm settings={settings} onSaved={setSettings} />
        </div>
      )}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-faint">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-faint leading-snug">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full bg-surface border rule-default rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--border-accent)]";

function SmtpForm({
  settings,
  onSaved,
  adminEmail,
}: {
  settings: Settings;
  onSaved: (s: Settings) => void;
  adminEmail: string;
}) {
  const [form, setForm] = useState(settings.smtp);
  /* Left blank means "keep the stored one". The password is never sent back to
     the browser, so there is nothing to prefill it with. */
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ text: string; bad?: boolean }>();
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState(adminEmail);

  function update<K extends keyof Settings["smtp"]>(key: K, value: Settings["smtp"][K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    try {
      const saved = await api.saveInstanceSettings({
        smtp: {
          host: form.host,
          port: Number(form.port),
          security: form.security,
          username: form.username,
          fromAddress: form.fromAddress,
          fromName: form.fromName,
          ...(password ? { password } : {}),
        },
      });
      setPassword("");
      onSaved(saved);
      setForm(saved.smtp);
      setMessage({ text: "Saved. Send a test to confirm it works." });
    } catch (err) {
      setMessage({
        text: err instanceof ApiError ? err.message : "Could not save.",
        bad: true,
      });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMessage(undefined);
    try {
      await api.testSmtp(testTo);
      setMessage({ text: `Sent. Check ${testTo}.` });
    } catch (err) {
      /* The server's own error, not a generic failure — "authentication
         failed" and "connection refused" need different fixes. */
      setMessage({
        text: err instanceof ApiError ? err.message : "Could not send.",
        bad: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">Email</h2>
        <p className="text-[12.5px] text-tertiary leading-[1.55]">
          Needed for password recovery and for delivering organization invitations. Without it,
          both still work but the link has to be copied out by hand.
        </p>
      </div>

      <form className="flex flex-col gap-3" onSubmit={save}>
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <Field label="Host">
            <input
              className={inputClass}
              value={form.host}
              onChange={(e) => update("host", e.target.value)}
              placeholder="smtp.example.com"
            />
          </Field>
          <Field label="Port">
            <input
              className={inputClass}
              value={form.port}
              onChange={(e) => update("port", e.target.value)}
              inputMode="numeric"
            />
          </Field>
        </div>

        <Field
          label="Security"
          hint="STARTTLS is usual on port 587; TLS on 465. Plaintext only for a relay on this machine."
        >
          <select
            className={inputClass}
            value={form.security}
            onChange={(e) => update("security", e.target.value as Settings["smtp"]["security"])}
          >
            <option value="starttls">STARTTLS — upgrade after connecting</option>
            <option value="tls">TLS — encrypted from the start</option>
            <option value="none">None — plaintext</option>
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Username">
            <input
              className={inputClass}
              value={form.username}
              onChange={(e) => update("username", e.target.value)}
              autoComplete="off"
              placeholder="Leave empty if the server needs no login"
            />
          </Field>
          <Field
            label="Password"
            hint={form.passwordSet ? "A password is stored. Leave blank to keep it." : undefined}
          >
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={form.passwordSet ? "••••••••" : ""}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="From address">
            <input
              className={inputClass}
              value={form.fromAddress}
              onChange={(e) => update("fromAddress", e.target.value)}
              placeholder="maestro@example.com"
            />
          </Field>
          <Field label="From name">
            <input
              className={inputClass}
              value={form.fromName}
              onChange={(e) => update("fromName", e.target.value)}
            />
          </Field>
        </div>

        {message && (
          <div
            className={`text-[12.5px] border rounded-lg px-3 py-2 ${
              message.bad
                ? "border-[var(--border-warn)] text-bad-hi"
                : "border-[var(--border-accent)] text-accent-hi"
            }`}
          >
            {message.text}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Working…" : "Save"}
          </button>
          <input
            className={`${inputClass} max-w-[240px]`}
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="Send a test to…"
          />
          <button type="button" className="btn" onClick={test} disabled={busy || !form.host}>
            Send test
          </button>
        </div>
      </form>
    </div>
  );
}

function RegistrationForm({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (s: Settings) => void;
}) {
  const [form, setForm] = useState(settings.registration);
  const [busy, setBusy] = useState(false);

  async function save(next: Settings["registration"]) {
    setBusy(true);
    setForm(next);
    try {
      onSaved(await api.saveInstanceSettings({ registration: next }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">
          Who can sign up
        </h2>
        <p className="text-[12.5px] text-tertiary leading-[1.55]">
          Registration closed after the first account. Reopen it only if you want anyone who can
          reach this server to create one.
        </p>
      </div>

      <label className="flex items-center gap-2.5 border rule rounded-lg px-3 py-2.5 bg-raised cursor-pointer">
        <input
          type="checkbox"
          checked={form.open}
          disabled={busy}
          onChange={(e) => void save({ ...form, open: e.target.checked })}
        />
        <span className="text-[13px]">Allow anyone to create an account</span>
      </label>

      {form.open && (
        <Field
          label="Restrict to a domain"
          hint="Leave empty to allow any address. With a domain set, only addresses at it may register."
        >
          <input
            className={inputClass}
            value={form.allowedDomain}
            onChange={(e) => setForm({ ...form, allowedDomain: e.target.value })}
            onBlur={() => void save(form)}
            placeholder="example.com"
          />
        </Field>
      )}
    </div>
  );
}
