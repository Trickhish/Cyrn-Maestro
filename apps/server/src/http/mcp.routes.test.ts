import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost, cookieFrom, body, signedInOwner } from "../test/harness";
import { decryptSecret, hashPassword } from "../lib/crypto";

/* Importing several MCP services from one gateway.
 *
 * The gateway is stood in for, so these tests are about what Maestro does with
 * the answer: that it stores one ordinary server per service, that the key is
 * encrypted and applied to each, and that it refuses the things it should. */

const PASSWORD = "a-long-enough-password";
const realFetch = globalThis.fetch;

let ownerCookie: string;
let outsiderCookie: string;

const GATEWAY = {
  services: [
    {
      id: "graphhopper",
      name: "GraphHopper",
      description: "Routing and geocoding",
      url: "https://mcp.dury.dev/graphhopper",
      requires_account: false,
      connected: true,
    },
    {
      id: "web_tools",
      name: "Web tools",
      description: "DNS, WHOIS, SSL",
      url: "https://mcp.dury.dev/web_tools",
      requires_account: false,
      connected: true,
    },
  ],
};

function gatewayAnswers(payload: unknown = GATEWAY, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const post = (cookie: string, path: string, payload: unknown) =>
  app.request(path, { ...jsonPost(payload), headers: { "content-type": "application/json", cookie } });

const discover = (cookie: string, payload: unknown = { baseUrl: "https://mcp.dury.dev", token: "imcp_k" }) =>
  post(cookie, "/api/mcp/gateway/discover", payload);

const importServices = (cookie: string, payload: Record<string, unknown>) =>
  post(cookie, "/api/mcp/gateway/import", {
    baseUrl: "https://mcp.dury.dev",
    token: "imcp_k",
    ...payload,
  });

beforeEach(async () => {
  resetDatabase();
  gatewayAnswers();

  ownerCookie = (await signedInOwner(app as never)).cookie;

  await db.insert(schema.users).values({
    id: crypto.randomUUID(),
    email: "outsider@example.com",
    passwordHash: await hashPassword(PASSWORD),
    instanceRole: "user",
    status: "active",
    createdAt: Date.now(),
  });
  outsiderCookie = cookieFrom(
    await app.request(
      "/api/auth/login",
      jsonPost({ email: "outsider@example.com", password: PASSWORD }),
    ),
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("discovering a gateway", () => {
  test("lists what the key can reach", async () => {
    const res = await discover(ownerCookie);
    expect(res.status).toBe(200);

    const payload = await body(res);
    expect(payload.base).toBe("https://mcp.dury.dev");
    expect(payload.services.map((s: { id: string }) => s.id)).toEqual(["graphhopper", "web_tools"]);
  });

  /* Looking must not store anything: a gateway someone decides against should
     leave no trace, least of all a key. */
  test("stores nothing", async () => {
    await discover(ownerCookie);
    expect(await db.select().from(schema.mcpServers)).toHaveLength(0);
  });

  test("marks what is already connected so nobody adds it twice", async () => {
    await importServices(ownerCookie, { serviceIds: ["graphhopper"] });

    const services = (await body(await discover(ownerCookie))).services as Array<{
      id: string;
      alreadyAdded: boolean;
    }>;
    expect(services.find((s) => s.id === "graphhopper")!.alreadyAdded).toBe(true);
    expect(services.find((s) => s.id === "web_tools")!.alreadyAdded).toBe(false);
  });

  test("passes the gateway's refusal through as a 502, not a 500", async () => {
    gatewayAnswers({ error: "invalid_token" }, 401);
    const res = await discover(ownerCookie);

    expect(res.status).toBe(502);
    expect((await body(res)).error).toMatch(/rejected that key/);
  });

  test("needs a signed-in actor", async () => {
    const res = await app.request(
      "/api/mcp/gateway/discover",
      jsonPost({ baseUrl: "https://mcp.dury.dev", token: "k" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("importing from a gateway", () => {
  test("creates one ordinary server per service", async () => {
    const res = await importServices(ownerCookie, { serviceIds: ["graphhopper", "web_tools"] });
    expect(res.status).toBe(200);
    expect((await body(res)).added).toEqual(["graphhopper", "web_tools"]);

    const rows = await db.select().from(schema.mcpServers);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.placement === "server" && r.transport === "http")).toBe(true);
    expect(rows.map((r) => r.url).sort()).toEqual([
      "https://mcp.dury.dev/graphhopper/",
      "https://mcp.dury.dev/web_tools/",
    ]);
  });

  test("gives each one the key as a bearer header, encrypted at rest", async () => {
    await importServices(ownerCookie, { serviceIds: ["graphhopper"] });

    const [row] = await db.select().from(schema.mcpServers);
    expect(row!.encryptedHeaders).toBeTruthy();
    expect(row!.encryptedHeaders).not.toContain("imcp_k");
    expect(JSON.parse(decryptSecret(row!.encryptedHeaders!))).toEqual({
      Authorization: "Bearer imcp_k",
    });
  });

  test("imports only what was picked", async () => {
    await importServices(ownerCookie, { serviceIds: ["web_tools"] });

    const rows = await db.select().from(schema.mcpServers);
    expect(rows.map((r) => r.name)).toEqual(["web_tools"]);
  });

  /* An underscore is legal in a namespace — unqualify splits on the first
     "__" — and refusing it would lock out a real service for no reason. */
  test("accepts a service whose id contains an underscore", async () => {
    const res = await importServices(ownerCookie, { serviceIds: ["web_tools"] });
    expect((await body(res)).added).toEqual(["web_tools"]);
  });

  test("applies the chosen approval to everything imported", async () => {
    await importServices(ownerCookie, { serviceIds: ["graphhopper"], approval: "auto" });

    const [row] = await db.select().from(schema.mcpServers);
    expect(row!.approval).toBe("auto");
  });

  test("defaults to asking, which is the safe end of that choice", async () => {
    await importServices(ownerCookie, { serviceIds: ["graphhopper"] });

    const [row] = await db.select().from(schema.mcpServers);
    expect(row!.approval).toBe("ask");
  });

  test("skips a name already taken rather than colliding on the namespace", async () => {
    await importServices(ownerCookie, { serviceIds: ["graphhopper"] });
    const res = await importServices(ownerCookie, { serviceIds: ["graphhopper", "web_tools"] });

    const payload = await body(res);
    expect(payload.added).toEqual(["web_tools"]);
    expect(payload.skipped).toEqual([
      { id: "graphhopper", reason: "A server of that name is already connected." },
    ]);
    expect(await db.select().from(schema.mcpServers)).toHaveLength(2);
  });

  /* The URL a service is reached at has to come from the gateway, not from
     whoever posted the form — otherwise the stored key could be aimed at a
     host of the caller's choosing. */
  test("ignores a service the gateway did not offer", async () => {
    const res = await importServices(ownerCookie, { serviceIds: ["evil"] });

    const payload = await body(res);
    expect(payload.added).toEqual([]);
    expect(payload.skipped[0].reason).toMatch(/does not offer/);
    expect(await db.select().from(schema.mcpServers)).toHaveLength(0);
  });

  test("stores nothing when the gateway rejects the key", async () => {
    gatewayAnswers({ error: "invalid_token" }, 401);
    const res = await importServices(ownerCookie, { serviceIds: ["graphhopper"] });

    expect(res.status).toBe(502);
    expect(await db.select().from(schema.mcpServers)).toHaveLength(0);
  });

  test("refuses an empty pick", async () => {
    const res = await importServices(ownerCookie, { serviceIds: [] });
    expect(res.status).toBe(400);
  });

  test("belongs to the account that imported it", async () => {
    const { actor } = await body(
      await app.request("/api/auth/login", jsonPost({ email: "owner@example.com", password: PASSWORD })),
    );
    await importServices(ownerCookie, { serviceIds: ["graphhopper"] });

    const [row] = await db.select().from(schema.mcpServers);
    expect(row!.ownerUserId).toBe(actor.id);
    expect(row!.ownerOrgId).toBeNull();
  });

  test("another account cannot see what was imported", async () => {
    await importServices(ownerCookie, { serviceIds: ["graphhopper"] });

    const res = await app.request("/api/mcp", { headers: { cookie: outsiderCookie } });
    expect((await body(res)).servers).toEqual([]);
  });

  test("records the import in the audit log", async () => {
    await importServices(ownerCookie, { serviceIds: ["graphhopper"] });

    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "mcp.connected"));
    expect(entries).toHaveLength(1);
  });
});

describe("server names", () => {
  test("accepts an underscore", async () => {
    const res = await post(ownerCookie, "/api/mcp", {
      name: "web_tools",
      url: "https://example.com/mcp/",
    });
    expect(res.status).toBe(201);
  });

  /* A double underscore in the name would be read as the separator, and every
     tool on that server would resolve to the wrong place. */
  test("refuses the namespace separator", async () => {
    const res = await post(ownerCookie, "/api/mcp", {
      name: "web__tools",
      url: "https://example.com/mcp/",
    });
    expect(res.status).toBe(400);
  });

  test("still refuses uppercase and spaces", async () => {
    for (const name of ["Web Tools", "WebTools", "web tools"]) {
      expect((await post(ownerCookie, "/api/mcp", { name, url: "https://e.com/" })).status).toBe(400);
    }
  });
});
