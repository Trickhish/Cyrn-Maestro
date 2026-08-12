import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost as json, cookieFrom, body } from "../test/harness";

/* Organizations are where privilege escalation lives. Most of these are about
   what a role must NOT be able to do. */

const PASSWORD = "a-long-enough-password";

async function account(email: string): Promise<string> {
  /* Registration closes after the first account, so later users are inserted
     directly and then signed in — the same path a real invitation produces. */
  const open = (await body<{ registrationOpen: boolean }>(await app.request("/api/auth/session")))
    .registrationOpen;

  if (open) {
    const res = await app.request("/api/auth/register", json({ email, password: PASSWORD }));
    return cookieFrom(res);
  }

  const { hashPassword } = await import("../lib/crypto");
  await db.insert(schema.users).values({
    id: crypto.randomUUID(),
    email,
    passwordHash: await hashPassword(PASSWORD),
    instanceRole: "user",
    status: "active",
    createdAt: Date.now(),
  });
  return cookieFrom(await app.request("/api/auth/login", json({ email, password: PASSWORD })));
}

const withCookie = (cookie: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie },
});

let ownerCookie: string;
let orgId: string;

beforeEach(async () => {
  resetDatabase();
  ownerCookie = await account("owner@x.com");

  const res = await app.request(
    "/api/orgs",
    withCookie(ownerCookie, json({ name: "Acme" })),
  );
  orgId = (await body(res)).organization.id;
});

describe("creating an organization", () => {
  test("the creator becomes its owner", async () => {
    const res = await app.request("/api/orgs", withCookie(ownerCookie));
    const orgs = (await body(res)).organizations;
    expect(orgs).toHaveLength(1);
    expect(orgs[0].role).toBe("owner");
  });

  test("only your own organizations are listed", async () => {
    const strangerCookie = await account("stranger@x.com");
    const res = await app.request("/api/orgs", withCookie(strangerCookie));
    expect((await body(res)).organizations).toHaveLength(0);
  });

  test("a non-member cannot read the member list", async () => {
    const strangerCookie = await account("stranger@x.com");
    const res = await app.request(`/api/orgs/${orgId}/members`, withCookie(strangerCookie));
    expect(res.status).toBe(404);
  });
});

describe("invitations", () => {
  async function invite(cookie: string, email: string, role: string) {
    return app.request(
      `/api/orgs/${orgId}/invitations`,
      withCookie(cookie, json({ email, role })),
    );
  }

  test("an owner can invite, and the link is returned once", async () => {
    const res = await invite(ownerCookie, "new@x.com", "member");
    expect(res.status).toBe(200);
    expect((await body(res)).link).toContain("/invite/inv_");
  });

  test("the token is stored hashed, not in the clear", async () => {
    const link = (await body(await invite(ownerCookie, "new@x.com", "member"))).link;
    const token = link.split("/invite/")[1];

    const [row] = await db.select().from(schema.invitations).limit(1);
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).not.toContain(token);
  });

  test("accepting joins the org with the invited role", async () => {
    const link = (await body(await invite(ownerCookie, "new@x.com", "member"))).link;
    const token = link.split("/invite/")[1];

    const newCookie = await account("new@x.com");
    const res = await app.request(
      "/api/orgs/invitations/accept",
      withCookie(newCookie, json({ token })),
    );
    expect(res.status).toBe(200);

    const mine = (await body(await app.request("/api/orgs", withCookie(newCookie)))).organizations;
    expect(mine[0].role).toBe("member");
  });

  /* A forwarded link must not let someone else take the seat. */
  test("an invitation is bound to the address it was sent to", async () => {
    const link = (await body(await invite(ownerCookie, "intended@x.com", "member"))).link;
    const token = link.split("/invite/")[1];

    const wrongCookie = await account("someone-else@x.com");
    const res = await app.request(
      "/api/orgs/invitations/accept",
      withCookie(wrongCookie, json({ token })),
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error).toContain("intended@x.com");
  });

  test("an invitation cannot be used twice", async () => {
    const link = (await body(await invite(ownerCookie, "new@x.com", "member"))).link;
    const token = link.split("/invite/")[1];

    const newCookie = await account("new@x.com");
    await app.request("/api/orgs/invitations/accept", withCookie(newCookie, json({ token })));

    const second = await app.request(
      "/api/orgs/invitations/accept",
      withCookie(newCookie, json({ token })),
    );
    expect(second.status).toBe(400);
  });

  test("an expired invitation is refused", async () => {
    const link = (await body(await invite(ownerCookie, "new@x.com", "member"))).link;
    const token = link.split("/invite/")[1];
    await db.update(schema.invitations).set({ expiresAt: Date.now() - 1000 });

    const newCookie = await account("new@x.com");
    const res = await app.request(
      "/api/orgs/invitations/accept",
      withCookie(newCookie, json({ token })),
    );
    expect((await body(res)).error).toContain("expired");
  });

  /* An admin creating an owner is a privilege escalation with extra steps. */
  test("an admin cannot invite an owner", async () => {
    const adminLink = (await body(await invite(ownerCookie, "admin@x.com", "admin"))).link;
    const adminCookie = await account("admin@x.com");
    await app.request(
      "/api/orgs/invitations/accept",
      withCookie(adminCookie, json({ token: adminLink.split("/invite/")[1] })),
    );

    const res = await invite(adminCookie, "escalate@x.com", "owner");
    expect(res.status).toBe(404);
  });

  test("a member cannot invite at all", async () => {
    const link = (await body(await invite(ownerCookie, "member@x.com", "member"))).link;
    const memberCookie = await account("member@x.com");
    await app.request(
      "/api/orgs/invitations/accept",
      withCookie(memberCookie, json({ token: link.split("/invite/")[1] })),
    );

    const res = await invite(memberCookie, "another@x.com", "viewer");
    expect(res.status).toBe(404);
  });
});

describe("roles and removal", () => {
  async function joinAs(email: string, role: string): Promise<{ cookie: string; userId: string }> {
    const link = (
      await body(
        await app.request(
          `/api/orgs/${orgId}/invitations`,
          withCookie(ownerCookie, json({ email, role })),
        ),
      )
    ).link;
    const cookie = await account(email);
    await app.request(
      "/api/orgs/invitations/accept",
      withCookie(cookie, json({ token: link.split("/invite/")[1] })),
    );
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    return { cookie, userId: user.id };
  }

  test("an owner can change a member's role", async () => {
    const { userId } = await joinAs("member@x.com", "member");
    const res = await app.request(`/api/orgs/${orgId}/members/${userId}`, {
      ...withCookie(ownerCookie),
      method: "PATCH",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(res.status).toBe(200);
  });

  /* An org with no owner cannot be administered, invited to, or deleted. */
  test("the last owner cannot leave", async () => {
    const [owner] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "owner@x.com"))
      .limit(1);

    const res = await app.request(`/api/orgs/${orgId}/members/${owner.id}`, {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toContain("only owner");
  });

  test("a member can remove themselves", async () => {
    const { cookie, userId } = await joinAs("leaver@x.com", "member");
    const res = await app.request(`/api/orgs/${orgId}/members/${userId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect((await body(await app.request("/api/orgs", withCookie(cookie)))).organizations).toHaveLength(0);
  });

  test("a member cannot remove someone else", async () => {
    const { cookie } = await joinAs("member@x.com", "member");
    const { userId: otherId } = await joinAs("other@x.com", "member");

    const res = await app.request(`/api/orgs/${orgId}/members/${otherId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});

describe("the audit log", () => {
  test("records creation, invitation and joining", async () => {
    const link = (
      await body(
        await app.request(
          `/api/orgs/${orgId}/invitations`,
          withCookie(ownerCookie, json({ email: "joiner@x.com", role: "member" })),
        ),
      )
    ).link;
    const joinerCookie = await account("joiner@x.com");
    await app.request(
      "/api/orgs/invitations/accept",
      withCookie(joinerCookie, json({ token: link.split("/invite/")[1] })),
    );

    const entries = (await body(await app.request(`/api/orgs/${orgId}/audit`, withCookie(ownerCookie)))).entries;
    const actions = entries.map((e: { action: string }) => e.action);

    expect(actions).toContain("org.created");
    expect(actions).toContain("member.invited");
    expect(actions).toContain("member.joined");
  });

  test("records who did it, by email as well as id", async () => {
    const entries = (await body(await app.request(`/api/orgs/${orgId}/audit`, withCookie(ownerCookie)))).entries;
    expect(entries[0].actorEmail).toBe("owner@x.com");
  });

  /* A viewer can see the org but not its administrative history. */
  test("a viewer cannot read the audit log", async () => {
    const link = (
      await body(
        await app.request(
          `/api/orgs/${orgId}/invitations`,
          withCookie(ownerCookie, json({ email: "viewer@x.com", role: "viewer" })),
        ),
      )
    ).link;
    const viewerCookie = await account("viewer@x.com");
    await app.request(
      "/api/orgs/invitations/accept",
      withCookie(viewerCookie, json({ token: link.split("/invite/")[1] })),
    );

    const res = await app.request(`/api/orgs/${orgId}/audit`, withCookie(viewerCookie));
    expect(res.status).toBe(404);
  });

  test("a non-member cannot read it at all", async () => {
    const strangerCookie = await account("stranger@x.com");
    const res = await app.request(`/api/orgs/${orgId}/audit`, withCookie(strangerCookie));
    expect(res.status).toBe(404);
  });
});
