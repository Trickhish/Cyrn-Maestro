import { useEffect, useState } from "react";
import { api, ApiError, type Organization } from "../lib/api";

/* The audit log, as a reader sees it.
 *
 * Append-only and read-only — there is deliberately no way to delete a line
 * from here, because a log the recorded party can edit is not evidence. */

const LABELS: Record<string, string> = {
  "org.created": "created the organization",
  "org.settings_changed": "changed organization settings",
  "member.invited": "invited",
  "member.joined": "joined",
  "member.left": "left",
  "member.removed": "removed",
  "member.role_changed": "changed a role for",
  "project.created": "created project",
  "project.brief_changed": "changed the brief for",
  "project.workspace_set": "registered a workspace for",
  "project.fact_set": "registered a fact for",
  "project.memory_added": "added a memory to",
  "project.note_removed": "removed a note from",
  "model_list.created": "created a model list",
  "model_list.changed": "changed a model list",
  "model_list.deleted": "deleted a model list",
  "model_list.entry_added": "added a model to a list for",
  "model_list.entry_removed": "removed a model from a list for",
  "model_group.created": "created a model group",
  "model_group.changed": "renamed a model group",
  "model_group.deleted": "deleted a model group",
  "model_group.member_added": "added a model to a group for",
  "model_group.member_removed": "removed a model from a group for",
  "model.tier_changed": "changed the tier for",
  "model.price_changed": "changed the price for",
  "model.enabled": "enabled model",
  "model.disabled": "disabled model",
  "project.deleted": "deleted project",
  "provider.added": "connected a provider",
  "provider.removed": "removed a provider",
  "node.enrollment_created": "created a node install token",
  "node.revoked": "revoked node",
  "node.renamed": "renamed a node",
  "task.approved": "approved a command in",
  "task.denied": "denied a command in",
  "auth.signed_in": "signed in",
  "auth.failed": "failed to sign in as",
};

/* Actions worth noticing at a glance rather than reading past. */
const NOTABLE = new Set([
  "member.role_changed",
  "member.removed",
  "provider.added",
  "provider.removed",
  "node.enrollment_created",
  "node.revoked",
  "task.denied",
  "auth.failed",
  "project.deleted",
]);

interface Entry {
  id: string;
  action: string;
  actorEmail: string | null;
  target: string | null;
  at: number;
  metadata?: Record<string, unknown> | null;
}

export function Activity({ org }: { org: Organization | undefined }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!org) return;
    api
      .audit(org.id)
      .then((r) => setEntries(r.entries as Entry[]))
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 404
            ? "Only owners and admins can read the activity log."
            : "Could not load the activity log.",
        ),
      );
  }, [org?.id]);

  if (!org) {
    return (
      <section className="flex-1 grid place-items-center bg-canvas">
        <p className="max-w-[380px] text-center text-[13px] text-faint">
          Activity is recorded per organization. Switch to one to see its log.
        </p>
      </section>
    );
  }

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-canvas overflow-auto scroll-quiet">
      <header className="h-[46px] flex-none flex items-center gap-3 px-4 md:px-[26px] border-b rule sticky top-0 bg-canvas z-10 overflow-x-auto scroll-quiet">
        <h1 className="font-display text-[14px] font-semibold whitespace-nowrap">Activity</h1>
        <span className="text-[12.5px] text-tertiary">{org.name}</span>
        <span className="flex-1" />
        <span className="hidden sm:inline font-mono text-[11px] text-faint whitespace-nowrap">append-only</span>
      </header>

      <div className="px-4 md:px-[26px] py-5 md:py-6 max-w-[860px] flex flex-col gap-1">
        {error && <div className="text-[13px] text-warn-hi">{error}</div>}

        {!error && entries.length === 0 && (
          <div className="text-[13px] text-faint">Nothing recorded yet.</div>
        )}

        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b rule py-2 text-[13px]"
          >
            <span
              className={`dot flex-none translate-y-[3px] ${
                NOTABLE.has(entry.action) ? "dot-needs" : "dot-idle"
              }`}
            />
            <span className="text-primary">{entry.actorEmail ?? "someone"}</span>
            <span className="text-tertiary">{LABELS[entry.action] ?? entry.action}</span>
            {entry.target && (
              <span className="font-mono text-[11.5px] text-secondary truncate max-w-[280px]">
                {entry.target}
              </span>
            )}
            <span className="flex-1" />
            <span className="font-mono text-[10.5px] text-faint tnum flex-none">
              {new Date(entry.at).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
