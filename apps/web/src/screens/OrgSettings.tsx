import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type OrganizationDetail, type ProviderModel } from "../lib/api";

/* Organization settings.
 *
 * Two things live here that nothing else can reach: who is in the organization,
 * and what it routes to by default. The defaults are the outermost rung of the
 * override ladder — a project, a rule or a pin on a task all beat them — so the
 * page says so rather than implying these are final.
 *
 * Everything is gated on what the viewer may actually do. A member can see the
 * roster and the defaults, because knowing why a task routed the way it did is
 * part of using the organization; only an admin can change either. */

const TIERS = ["light", "standard", "heavy"] as const;
const ROLES = ["viewer", "member", "admin", "owner"] as const;

const ROLE_NOTES: Record<string, string> = {
  viewer: "Reads projects and tasks. Runs nothing.",
  member: "Runs tasks and creates projects. Cannot change connections or members.",
  admin: "Everything except handing over or destroying the organization.",
  owner: "Full control, including transferring and deleting.",
};

interface Member {
  userId: string;
  email: string;
  role: string;
  since: number;
}

export function OrgSettings({
  orgId,
  actorId,
  onChanged,
}: {
  orgId: string;
  actorId: string;
  onChanged: () => void;
}) {
  const [org, setOrg] = useState<OrganizationDetail>();
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<
    Array<{ id: string; email: string; role: string; expiresAt: number }>
  >([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [error, setError] = useState<string>();

  const may = (permission: string) => org?.permissions.includes(permission) ?? false;
  const owners = members.filter((m) => m.role === "owner").length;

  async function refresh() {
    try {
      const [detail, roster] = await Promise.all([api.org(orgId), api.members(orgId)]);
      setOrg(detail.organization);
      setMembers(roster.members);
      setInvitations(roster.invitations);
      setError(undefined);

      /* Only useful for choosing a default model, and only an admin can. */
      if (detail.organization.permissions.includes("org.settings")) {
        const { providers } = await api.providers();
        setModels(providers.flatMap((p) => p.models.filter((m) => m.probeOk !== false)));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the organization.");
    }
  }

  useEffect(() => {
    void refresh();
  }, [orgId]);

  if (error && !org) {
    return (
      <section className="flex-1 grid place-items-center bg-canvas">
        <p className="text-[13px] text-bad-hi">{error}</p>
      </section>
    );
  }
  if (!org) {
    return (
      <section className="flex-1 grid place-items-center bg-canvas">
        <p className="text-[13px] text-faint">Loading…</p>
      </section>
    );
  }

  async function patch(values: Record<string, unknown>) {
    try {
      await api.updateOrg(orgId, values);
      await refresh();
      /* A rename shows up in the switcher and the top bar, which live above
         this screen. */
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that.");
    }
  }

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-canvas overflow-auto scroll-quiet">
      <header className="h-[46px] flex-none flex items-center gap-3 px-4 md:px-[26px] border-b rule sticky top-0 bg-canvas z-10 overflow-x-auto scroll-quiet">
        <h1 className="font-display text-[14px] font-semibold whitespace-nowrap">Organization</h1>
        <span className="hidden sm:inline text-[12.5px] text-tertiary whitespace-nowrap">
          {org.name}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-faint whitespace-nowrap">{org.role}</span>
      </header>

      <div className="px-4 md:px-[26px] py-5 md:py-6 flex flex-col gap-8 max-w-[680px]">
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">General</h2>
          <p className="text-[12.5px] text-tertiary leading-[1.55]">
            You are {article(org.role)} <span className="text-secondary">{org.role}</span> here.{" "}
            {ROLE_NOTES[org.role]}
          </p>
        </div>

        <Labelled
          label="Name"
          hint={`Its address stays /${org.slug} — links already shared keep working.`}
        >
          <input
            className={fieldClass}
            defaultValue={org.name}
            disabled={!may("org.settings")}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next && next !== org.name) void patch({ name: next });
            }}
          />
        </Labelled>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">
            Defaults for every project
          </h2>
          <p className="text-[12.5px] text-tertiary leading-[1.55]">
            The outermost rung of the ladder. A project's own settings, a routing rule, or a model
            pinned on a task all override these.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Labelled label="Tier">
            <select
              className={fieldClass}
              value={org.defaultTier ?? ""}
              disabled={!may("org.settings")}
              onChange={(e) => void patch({ defaultTier: e.target.value || null })}
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
              className={fieldClass}
              value={org.defaultModelId ?? ""}
              disabled={!may("org.settings")}
              onChange={(e) => void patch({ defaultModelId: e.target.value || null })}
            >
              <option value="">Let the router decide</option>
              {/* A member cannot load the model list, so the stored value is
                  shown as itself rather than as an empty box. */}
              {models.length === 0 && org.defaultModelId && (
                <option value={org.defaultModelId}>{org.defaultModelId}</option>
              )}
              {models.map((model) => (
                <option key={model.id} value={model.modelId}>
                  {model.modelId} · {model.tier}
                </option>
              ))}
            </select>
          </Labelled>
        </div>

        <Labelled
          label="Spend cap (USD)"
          hint="Across the whole organization. Tasks stop rather than exceed it."
        >
          <input
            className={fieldClass}
            defaultValue={org.spendCapUsd ?? ""}
            inputMode="decimal"
            placeholder="No cap"
            disabled={!may("org.settings")}
            onBlur={(e) => {
              const raw = e.target.value.trim();
              const next = raw === "" ? null : Number(raw);
              if (next !== null && !Number.isFinite(next)) return;
              if (next !== org.spendCapUsd) void patch({ spendCapUsd: next });
            }}
          />
        </Labelled>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-mono text-[10px] tracking-[0.14em] uppercase text-faint">Members</h2>
          <p className="text-[12.5px] text-tertiary leading-[1.55]">
            Everyone who can work in {org.name}. Projects, nodes and provider keys here belong to
            the organization, not to whoever added them.
          </p>
        </div>

        {members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            orgId={orgId}
            isSelf={member.userId === actorId}
            /* An org with no owner cannot be administered, so the server
               refuses the last one leaving. Not offering it beats offering it
               and then explaining. */
            isLastOwner={member.role === "owner" && owners === 1}
            canManage={may("member.invite")}
            canRemove={may("member.remove")}
            myRole={org.role}
            onChanged={refresh}
            onError={setError}
          />
        ))}

        {invitations.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-faint">
              invited, not yet joined
            </span>
            {invitations.map((invite) => (
              <div
                key={invite.id}
                className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border rule rounded-lg px-3 py-2 bg-raised"
              >
                <span className="dot dot-idle" />
                <span className="text-[13px]">{invite.email}</span>
                <span className="font-mono text-[10.5px] text-faint">{invite.role}</span>
                <span className="flex-1" />
                <span className="font-mono text-[10.5px] text-faint whitespace-nowrap">
                  expires {new Date(invite.expiresAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}

        {may("member.invite") && <Invite orgId={orgId} canMakeOwner={may("org.delete")} onInvited={refresh} />}
      </section>

      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}
      </div>
    </section>
  );
}

function MemberRow({
  member,
  orgId,
  isSelf,
  isLastOwner,
  canManage,
  canRemove,
  myRole,
  onChanged,
  onError,
}: {
  member: Member;
  orgId: string;
  isSelf: boolean;
  isLastOwner: boolean;
  canManage: boolean;
  canRemove: boolean;
  myRole: string;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  /* Only an owner outranks an owner. The server enforces this; the interface
     matches it so the control is not offered and then refused. */
  const locked = member.role === "owner" && myRole !== "owner";

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not do that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border rule rounded-lg px-3 py-2.5 bg-raised">
      <span className={member.role === "owner" ? "dot dot-running" : "dot dot-idle"} />
      <span className="text-[13px]">{member.email}</span>
      {isSelf && <span className="font-mono text-[9.5px] text-accent-hi">you</span>}
      <span className="flex-1" />

      {canManage && !locked && !isLastOwner ? (
        <select
          value={member.role}
          disabled={busy}
          onChange={(e) => void run(() => api.setMemberRole(orgId, member.userId, e.target.value))}
          className="bg-surface border rule rounded px-1.5 py-0.5 font-mono text-[10.5px] text-secondary outline-none"
        >
          {ROLES.map((role) => (
            <option key={role} value={role} disabled={role === "owner" && myRole !== "owner"}>
              {role}
            </option>
          ))}
        </select>
      ) : (
        <span className="font-mono text-[10.5px] text-tertiary">{member.role}</span>
      )}

      {isLastOwner && (
        <span className="font-mono text-[9.5px] text-faint whitespace-nowrap">
          the only owner
        </span>
      )}

      {/* Leaving is always yours to do; removing someone else is a permission. */}
      {!isLastOwner && (isSelf || (canRemove && !locked)) && (
        <button
          type="button"
          className="btn btn-chip"
          disabled={busy}
          onClick={() => void run(() => api.removeMember(orgId, member.userId))}
        >
          {isSelf ? "Leave" : "Remove"}
        </button>
      )}
    </div>
  );
}

function Invite({
  orgId,
  canMakeOwner,
  onInvited,
}: {
  orgId: string;
  canMakeOwner: boolean;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { link: url } = await api.invite(orgId, email.trim(), role);
      setLink(url);
      setEmail("");
      onInvited();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create that invitation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-2 border rule rounded-lg px-3 py-3 bg-surface" onSubmit={submit}>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2">
        <Labelled label="Invite by email">
          <input
            className={fieldClass}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@example.com"
            required
          />
        </Labelled>
        <Labelled label="As">
          <select className={fieldClass} value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.filter((r) => r !== "owner" || canMakeOwner).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Labelled>
      </div>

      <p className="text-[11.5px] text-faint leading-snug">{ROLE_NOTES[role]}</p>

      {error && <div className="text-[12.5px] text-bad-hi">{error}</div>}

      <button type="submit" className="btn btn-primary self-start" disabled={busy}>
        {busy ? "Creating…" : "Create invitation"}
      </button>

      {/* Shown once, because only its hash is kept. Until email delivery is
          wired up this link is the only way the invitation travels. */}
      {link && (
        <div className="flex flex-col gap-1.5 border border-[var(--border-accent)] bg-raised rounded-lg p-2.5">
          <span className="text-[12px] text-secondary">
            Send this to them. It works once, expires in seven days, and is not shown again.
          </span>
          <div className="font-mono text-[11.5px] text-primary bg-inset border rule rounded px-2 py-1.5 overflow-x-auto scroll-quiet whitespace-nowrap">
            {link}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void navigator.clipboard?.writeText(link)}
            >
              Copy
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setLink(undefined)}>
              Done
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

const fieldClass =
  "w-full bg-surface border rule-default rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--border-accent)] disabled:opacity-60";

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

function article(role: string): string {
  return /^[aeiou]/.test(role) ? "an" : "a";
}
