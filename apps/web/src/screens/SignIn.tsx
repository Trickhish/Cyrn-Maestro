import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Actor } from "../lib/api";

/* The one screen that exists before anything else does. On a fresh instance it
   offers registration; after the first account it offers sign-in only, because
   a self-hosted instance should not be a land grab. */

interface SignInProps {
  registrationOpen: boolean;
  onSignedIn: (actor: Actor) => void;
}

export function SignIn({ registrationOpen, onSignedIn }: SignInProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  /* OVH's field the user confirmed autofill works on is type="number", which
     cannot hold a recovery code (letters and dashes) — the same field cannot
     be both, so this splits them the way OVH's own page does too: its "no
     longer have access" link is a visibly separate path, not the same input
     coerced to take two shapes. */
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  /* Focused imperatively rather than with the `autoFocus` prop: the field
     stays mounted the whole time (see the input below), so there is no mount
     event for autoFocus to fire on when the code step actually begins — only
     a class toggle. */
  useEffect(() => {
    if (needsCode) codeRef.current?.focus();
  }, [needsCode]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setFieldErrors({});

    try {
      const { actor } = registrationOpen
        ? await api.register(email, password)
        : await api.login(email, password, code || undefined);
      onSignedIn(actor);
    } catch (err) {
      if (err instanceof ApiError) {
        /* The password was right and only the factor is missing, so ask for a
           code rather than making the user retype credentials that worked. */
        if ((err as ApiError & { needsSecondFactor?: boolean }).needsSecondFactor) {
          setNeedsCode(true);
        }
        setError(err.message);
        setFieldErrors(err.details ?? {});
      } else {
        setError("Could not reach the server.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid place-items-center bg-canvas-alt px-4">
      <div className="w-full max-w-[380px] flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <img src="/logo-mark-arcs.svg" alt="" width={26} height={26} />
          <span className="font-display text-[17px] font-semibold tracking-[-0.01em]">maestro</span>
        </div>

        <div className="flex flex-col gap-1">
          <h1 className="font-display text-[20px] font-semibold tracking-[-0.02em]">
            {registrationOpen ? "Create the first account" : "Sign in"}
          </h1>
          <p className="text-[13px] text-tertiary leading-[1.55]">
            {registrationOpen
              ? "This instance has no accounts yet. The first one becomes the administrator, and registration closes after it."
              : "Registration is closed on this instance."}
          </p>
        </div>

        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label="Email" errors={fieldErrors.email}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              className="w-full bg-surface border rule-default rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--border-accent)]"
            />
          </Field>

          <Field label="Password" errors={fieldErrors.password}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={registrationOpen ? "new-password" : "current-password"}
              required
              className="w-full bg-surface border rule-default rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--border-accent)]"
            />
          </Field>

          <Field
            label="Authenticator code"
            hint="Only used if this account has two-factor turned on."
          >
            {useRecoveryCode ? (
              <input
                ref={codeRef}
                type="text"
                name="recovery-code"
                id="recovery-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Recovery code"
                className="w-full bg-surface border rule-default rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--border-accent)]"
              />
            ) : (
              /* Matched to OVH's own working field exactly: type, id, name,
                 and nothing else — no autocomplete, inputmode, or spellcheck
                 attributes, since the point of this pass is to rule out
                 whether one of those was itself the thing stopping autofill. */
              <input
                ref={codeRef}
                type="number"
                name="totp"
                id="totp"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Code"
                className="w-full bg-surface border rule-default rounded-lg px-3 py-2 text-[13.5px] outline-none focus:border-[var(--border-accent)]"
              />
            )}
          </Field>

          <button
            type="button"
            className="text-[11.5px] text-tertiary hover:text-secondary text-left -mt-1.5"
            onClick={() => {
              setUseRecoveryCode(!useRecoveryCode);
              setCode("");
            }}
          >
            {useRecoveryCode ? "Use an authenticator code instead" : "Use a recovery code instead"}
          </button>

          {error && (
            <div className="text-[12.5px] text-bad-hi border border-[var(--border-warn)] bg-raised rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary mt-1" disabled={busy}>
            {busy ? "Working…" : registrationOpen ? "Create account" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  errors,
  children,
}: {
  label: string;
  hint?: string;
  errors?: string[];
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-faint">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint leading-snug">{hint}</span>}
      {errors?.length ? <span className="text-[12px] text-bad-hi">{errors[0]}</span> : null}
    </label>
  );
}
