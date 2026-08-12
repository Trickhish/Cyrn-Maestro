import { expect, test, describe, beforeEach } from "bun:test";
import { desc } from "drizzle-orm";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { record } from "./audit";
import type { Actor } from "./auth";

const alice: Actor = { id: "alice", email: "alice@x.com", instanceRole: "user" };
const ORG = "org-1";

beforeEach(async () => {
  resetDatabase();
  const now = Date.now();
  await db.insert(schema.users).values({
    id: "alice", email: "alice@x.com", passwordHash: "x",
    instanceRole: "user", status: "active", createdAt: now,
  });
  await db.insert(schema.organizations).values({
    id: ORG, name: "Acme", slug: "acme", require2fa: false, createdAt: now,
  });
});

const entries = () =>
  db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.at));

describe("recording", () => {
  test("stores the action, the actor and the target", async () => {
    await record(ORG, alice, "provider.added", "prov-1", { name: "CLIProxy" });

    const [row] = await entries();
    expect(row.action).toBe("provider.added");
    expect(row.actorUserId).toBe("alice");
    expect(row.target).toBe("prov-1");
    expect(row.metadata).toEqual({ name: "CLIProxy" });
  });

  /* An id stops meaning anything once the user row is gone, and "who did this"
     is the question the log exists to answer months later. */
  test("keeps the actor's email so the record survives the account", async () => {
    await record(ORG, alice, "member.removed", "bob");
    await db.delete(schema.users);

    const [row] = await entries();
    expect(row.actorUserId).toBeNull();
    expect(row.actorEmail).toBe("alice@x.com");
    expect(row.action).toBe("member.removed");
  });

  test("records an action with no actor, for a failed sign-in", async () => {
    await record(null, null, "auth.failed", "someone@x.com");

    const [row] = await entries();
    expect(row.actorUserId).toBeNull();
    expect(row.action).toBe("auth.failed");
    expect(row.target).toBe("someone@x.com");
  });

  /* Losing one line is bad; failing a role change because the log write failed
     is worse. The failure is logged loudly instead. */
  test("never throws, even when the write cannot succeed", async () => {
    await expect(
      record("no-such-org", alice, "something", null),
    ).resolves.toBeUndefined();
  });
});

describe("scoping", () => {
  test("org entries are separable from instance ones", async () => {
    await record(ORG, alice, "org.created", ORG);
    await record(null, alice, "auth.signed_in");

    const all = await entries();
    expect(all.filter((e) => e.orgId === ORG)).toHaveLength(1);
    expect(all.filter((e) => e.orgId === null)).toHaveLength(1);
  });

  /* Deleting an org takes its history with it — the alternative is orphaned
     rows naming people and resources that no longer exist. */
  test("an org's entries go when the org does", async () => {
    await record(ORG, alice, "org.created", ORG);
    await db.delete(schema.organizations);
    expect(await entries()).toHaveLength(0);
  });
});
