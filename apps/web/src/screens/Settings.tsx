import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { QrCode } from "../components/QrCode";

/* Account settings.
 *
 * Three things that were previously only possible with a shell one-liner:
 * changing a password, seeing where you are signed in, and turning on a second
 * factor. */

interface AccountStatus {
  email: string;
  instanceRole: string;
  createdAt: number;
  twoFactor: { enabled: boolean; enabledAt: number | null; hasRecoveryCodes: boolean };
}

interface SessionRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  expiresAt: number;
  current: boolean;
}

export function Settings() {
  const [status, setStatus] = useState<AccountStatus>();
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  async function refresh() {
    const [a, s] = await Promise.all([api.account(), api.sessions()]);
    setStatus(a);
    setSessions(s.sessions);
  }

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-canvas overflow-auto scroll-quiet">
      <header className="h-[46px] flex-none flex items-center gap-3 px-[26px] border-b rule sticky top-0 bg-canvas z-10">
        <h1 className="font-display text-[14px] font-semibold">Settings</h1>
        <span className="text-[12.5px] text-tertiary">{status?.email}</span>
        <span className="flex-1" />
        {status?.instanceRole === "instance_admin" && (
          <span className="font-mono text-[10px] text-faint">instance admin</span>
        )}
      </header>

      <div className="px-[26px] py-6 flex flex-col gap-8 max-w-[620px]">
        <PasswordSection onChanged={refresh} />
        <TwoFactorSection status={status} onChanged={refresh} />
        <SessionsSection sessions={sessions} onChanged={refresh} />
      </div>
    </section>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">{title}</h2>
        {note && <p className="text-[12.5px] text-tertiary leading-[1.55]">{note}</p>}
      </div>
      {children}
    </div>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full bg-surface border rule-default rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--border-accent)]"
    />
  );
}

function Message({ text, bad }: { text: string; bad?: boolean }) {
  return (
    <div
      className={`text-[12.5px] border rounded-lg px-3 py-2 ${
        bad ? "border-[var(--border-warn)] text-bad-hi" : "border-[var(--border-accent)] text-accent-hi"
      }`}
    >
      {text}
    </div>
  );
}

function PasswordSection({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<{ text: string; bad?: boolean }>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setMessage({ text: "Password changed. Every other session was signed out." });
      onChanged();
    } catch (err) {
      setMessage({
        text: err instanceof ApiError ? (err.details?.newPassword?.[0] ?? err.message) : "Could not change it.",
        bad: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Password"
      note="Changing it signs out every other session, in case someone else has one."
    >
      <form className="flex flex-col gap-2" onSubmit={submit}>
        <Input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
          required
        />
        <Input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="New password — at least 10 characters"
          autoComplete="new-password"
          required
        />
        {message && <Message {...message} />}
        <button type="submit" className="btn btn-primary self-start" disabled={busy}>
          {busy ? "Changing…" : "Change password"}
        </button>
      </form>
    </Section>
  );
}

function TwoFactorSection({
  status,
  onChanged,
}: {
  status?: AccountStatus;
  onChanged: () => void;
}) {
  const [setup, setSetup] = useState<{ secret: string; uri: string }>();
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>();
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ text: string; bad?: boolean }>();

  if (!status) return null;

  /* Shown once, at the moment it becomes real. There is no read path back to
     them — only the hashes are stored. */
  if (codes) {
    return (
      <Section
        title="Recovery codes"
        note="Save these now. Each works once, in place of your authenticator, and they cannot be shown again."
      >
        <div className="grid grid-cols-2 gap-1.5 font-mono text-[12.5px] bg-inset border rule rounded-lg p-3">
          {codes.map((c) => (
            <span key={c} className="text-primary">
              {c}
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))}
          >
            Copy
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setCodes(undefined)}>
            I have saved them
          </button>
        </div>
      </Section>
    );
  }

  if (status.twoFactor.enabled) {
    return (
      <Section title="Two-factor authentication" note="On. Sign-in asks for a code from your app.">
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setMessage(undefined);
            try {
              await api.disable2fa(password);
              setPassword("");
              onChanged();
            } catch (err) {
              setMessage({
                text: err instanceof ApiError ? err.message : "Could not turn it off.",
                bad: true,
              });
            }
          }}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password, to turn it off"
            autoComplete="current-password"
            required
          />
          {message && <Message {...message} />}
          <button type="submit" className="btn self-start">
            Turn off
          </button>
        </form>
      </Section>
    );
  }

  if (setup) {
    return (
      <Section
        title="Two-factor authentication"
        note="Scan this with your authenticator app, then enter the code it shows."
      >
        <div className="flex flex-wrap items-start gap-4">
          <QrCode value={setup.uri} />

          <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
            <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-faint">
              or enter this by hand
            </span>
            {/* Grouped in fours, because this gets typed on a phone keyboard
                by anyone whose camera will not focus. */}
            <div className="font-mono text-[13px] leading-[1.7] text-primary bg-inset border rule rounded-lg px-3 py-2.5 break-all">
              {setup.secret.match(/.{1,4}/g)?.join(" ")}
            </div>
            <button
              type="button"
              className="btn btn-sm self-start"
              onClick={() => void navigator.clipboard?.writeText(setup.secret)}
            >
              Copy secret
            </button>
          </div>
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setMessage(undefined);
            try {
              const result = await api.confirm2fa(code);
              setCodes(result.recoveryCodes);
              setSetup(undefined);
              setCode("");
              onChanged();
            } catch (err) {
              setMessage({
                text: err instanceof ApiError ? err.message : "Could not confirm it.",
                bad: true,
              });
            }
          }}
        >
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Six-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
          {message && <Message {...message} />}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary">
              Confirm
            </button>
            <button type="button" className="btn" onClick={() => setSetup(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      </Section>
    );
  }

  return (
    <Section
      title="Two-factor authentication"
      note="Off. Turning it on means sign-in needs a code from your phone as well as your password."
    >
      <button
        type="button"
        className="btn btn-primary self-start"
        onClick={async () => {
          setSetup(await api.begin2fa());
        }}
      >
        Turn on
      </button>
    </Section>
  );
}

function SessionsSection({
  sessions,
  onChanged,
}: {
  sessions: SessionRow[];
  onChanged: () => void;
}) {
  return (
    <Section title="Signed in" note="Everywhere this account currently has a session.">
      <div className="flex flex-col gap-1">
        {sessions.map((session) => (
          <div
            key={session.id}
            className="flex items-center gap-2.5 border rule rounded-lg px-3 py-2.5 bg-raised"
          >
            <span className={session.current ? "dot dot-live" : "dot dot-idle"} />
            <span className="text-[12.5px] text-secondary truncate flex-1">
              {session.userAgent?.slice(0, 60) ?? "Unknown device"}
            </span>
            {session.ip && <span className="font-mono text-[10.5px] text-faint">{session.ip}</span>}
            <span className="font-mono text-[10.5px] text-faint tnum">
              {new Date(session.createdAt).toLocaleDateString()}
            </span>
            {session.current ? (
              <span className="font-mono text-[10px] text-accent-hi">this one</span>
            ) : (
              <button
                type="button"
                className="btn btn-chip"
                onClick={async () => {
                  await api.revokeSession(session.id);
                  onChanged();
                }}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>

      {sessions.length > 1 && (
        <button
          type="button"
          className="btn self-start"
          onClick={async () => {
            await api.revokeOtherSessions();
            onChanged();
          }}
        >
          Sign out everywhere else
        </button>
      )}
    </Section>
  );
}
