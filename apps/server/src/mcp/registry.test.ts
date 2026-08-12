import { expect, test, describe, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { qualify, unqualify, NAMESPACE_SEPARATOR } from "./client";
import { runMcpTool, isMcpTool, resolveMcpTools } from "./registry";

const USER = "u1";
const PROJECT = "p1";

async function seed() {
  const now = Date.now();
  await db.insert(schema.users).values({
    id: USER, email: "u@x.com", passwordHash: "x",
    instanceRole: "user", status: "active", createdAt: now,
  });
  await db.insert(schema.projects).values({
    id: PROJECT, ownerUserId: USER, ownerOrgId: null, name: "P", slug: "p",
    repoUrl: null, branch: null, instructions: null,
    defaultModelId: null, defaultTier: null, spendCapUsd: null, createdAt: now,
  });
}

async function addServer(over: Partial<typeof schema.mcpServers.$inferInsert> = {}) {
  const row = {
    id: crypto.randomUUID(),
    projectId: PROJECT,
    name: "github",
    placement: "server" as const,
    transport: "http" as const,
    url: "https://mcp.test/",
    encryptedHeaders: null,
    command: null,
    args: null,
    encryptedEnv: null,
    enabled: true,
    toolAllowlist: [] as string[],
    approval: "ask" as const,
    lastError: null,
    lastConnectedAt: null,
    createdAt: Date.now(),
    ...over,
  };
  await db.insert(schema.mcpServers).values(row);
  return row;
}

beforeEach(async () => {
  resetDatabase();
  await seed();
});

describe("namespacing", () => {
  /* Two servers exposing "search" would otherwise collide, and the model would
     call one meaning the other. */
  test("a tool is qualified by its server", () => {
    expect(qualify("github", "create_issue")).toBe(`github${NAMESPACE_SEPARATOR}create_issue`);
  });

  test("qualification round-trips", () => {
    const parsed = unqualify(qualify("linear", "search"));
    expect(parsed).toEqual({ serverName: "linear", toolName: "search" });
  });

  test("a tool name containing the separator still resolves to the right server", () => {
    const parsed = unqualify(qualify("github", "list__repos"));
    expect(parsed?.serverName).toBe("github");
    expect(parsed?.toolName).toBe("list__repos");
  });

  test("an unqualified name is not an MCP tool", () => {
    expect(isMcpTool("bash")).toBe(false);
    expect(isMcpTool("read_file")).toBe(false);
    expect(isMcpTool("github__create_issue")).toBe(true);
  });
});

describe("what a call is allowed to reach", () => {
  test("an unknown server is refused by name", async () => {
    const result = await runMcpTool(PROJECT, "nowhere__do_thing", {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain('no MCP server called "nowhere"');
  });

  /* The allowlist is a boundary, not a display filter. A model that guesses a
     tool name outside it must not reach the server. */
  test("a tool outside the allowlist cannot be called even if guessed", async () => {
    await addServer({ toolAllowlist: ["create_issue"] });

    const result = await runMcpTool(PROJECT, "github__delete_repo", {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not enabled");
  });

  test("a server set to never is refused", async () => {
    await addServer({ approval: "never" });
    const result = await runMcpTool(PROJECT, "github__create_issue", {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("never run tools");
  });

  test("a disabled server is refused", async () => {
    await addServer({ enabled: false });
    const result = await runMcpTool(PROJECT, "github__create_issue", {});
    expect(result.ok).toBe(false);
  });

  /* A server belonging to another project must not be reachable by name. */
  test("a server on a different project is not reachable", async () => {
    await db.insert(schema.projects).values({
      id: "p2", ownerUserId: USER, ownerOrgId: null, name: "Other", slug: "other",
      repoUrl: null, branch: null, instructions: null,
      defaultModelId: null, defaultTier: null, spendCapUsd: null, createdAt: Date.now(),
    });
    await addServer({ projectId: "p2", name: "private" });

    const result = await runMcpTool(PROJECT, "private__secret", {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no MCP server");
  });
});

describe("resolving a project's tools", () => {
  test("a project with no servers gets nothing, and no errors", async () => {
    const resolved = await resolveMcpTools(PROJECT);
    expect(resolved.tools).toHaveLength(0);
    expect(resolved.problems).toHaveLength(0);
  });

  test("a server set to never contributes no tools", async () => {
    await addServer({ approval: "never" });
    expect((await resolveMcpTools(PROJECT)).tools).toHaveLength(0);
  });

  /* Configured-but-inert is stated rather than looking like an empty result. */
  test("a node-placed server reports that it is not started yet", async () => {
    await addServer({ placement: "node", transport: "stdio", command: "npx", url: null });

    const resolved = await resolveMcpTools(PROJECT);
    expect(resolved.tools).toHaveLength(0);
    expect(resolved.problems[0].message).toContain("not yet started");
  });

  /* A server that will not connect should be visible in the thread rather than
     an unexplained absence of tools. */
  test("an unreachable server becomes a problem and is recorded", async () => {
    await addServer({ url: "http://127.0.0.1:9/" });

    const resolved = await resolveMcpTools(PROJECT);
    expect(resolved.tools).toHaveLength(0);
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0].server).toBe("github");

    const [row] = await db.select().from(schema.mcpServers).limit(1);
    expect(row.lastError).toBeTruthy();
  }, 20_000);
});
