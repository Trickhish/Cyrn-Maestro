import { useState } from "react";
import { api, setActiveOrg, type Organization } from "../lib/api";

/* The org switcher.
 *
 * Switching is a full reload rather than a re-fetch. Every screen holds data
 * scoped to one owner — projects, nodes, providers, tasks — and reloading is
 * the one way to guarantee none of the previous tenant's data is still on
 * screen. Correctness beats smoothness at a tenancy boundary. */

interface OrgSwitcherProps {
  organizations: Organization[];
  activeOrgId: string | null;
  personalLabel: string;
}

export function OrgSwitcher({ organizations, activeOrgId, personalLabel }: OrgSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const active = organizations.find((o) => o.id === activeOrgId);

  function switchTo(orgId: string | null) {
    setActiveOrg(orgId);
    location.hash = "";
    location.reload();
  }

  return (
    <div className="relative px-2 pb-2">
      <button
        type="button"
        className="rail-item w-full"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={active ? "dot dot-running" : "dot dot-idle"} />
        <span className="flex-1 truncate text-left">{active ? active.name : personalLabel}</span>
        <span className="text-faint text-[10px]">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="absolute left-2 right-2 top-full z-20 mt-1 flex flex-col gap-px rounded-lg border rule-default bg-surface p-1 shadow-lg">
          <button
            type="button"
            className="rail-item"
            data-active={!activeOrgId}
            onClick={() => switchTo(null)}
          >
            <span className="dot dot-idle" />
            <span className="flex-1 truncate text-left">{personalLabel}</span>
            <span className="font-mono text-[10px] text-faint">personal</span>
          </button>

          {organizations.map((org) => (
            <button
              key={org.id}
              type="button"
              className="rail-item"
              data-active={org.id === activeOrgId}
              onClick={() => switchTo(org.id)}
            >
              <span className="dot dot-running" />
              <span className="flex-1 truncate text-left">{org.name}</span>
              <span className="font-mono text-[10px] text-faint">{org.role}</span>
            </button>
          ))}

          <div className="my-1 border-t rule" />

          {creating ? (
            <form
              className="p-1"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!name.trim()) return;
                const { organization } = await api.createOrg(name.trim());
                switchTo(organization.id);
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Organization name"
                className="w-full rounded border rule-default bg-canvas px-2 py-1 text-[12.5px] outline-none focus:border-[var(--border-accent)]"
              />
            </form>
          ) : (
            <button
              type="button"
              className="px-2 py-1.5 text-left text-[12px] text-faint hover:text-secondary"
              onClick={() => setCreating(true)}
            >
              + New organization
            </button>
          )}
        </div>
      )}
    </div>
  );
}
