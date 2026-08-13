import { expect, test, describe, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { resetListeners, replay } from "./events";
import { listMcpToolsCall } from "./runner";
import type { ResolvedMcp } from "../mcp/registry";

/* list_mcp_tools is how a server's real tools become callable — the model
 * asks by name, gets back what is on it (under the name it must actually use
 * to call one), and that server stays open for the rest of the task. This is
 * the discovery half of the same trade skills already make: a line per
 * server in the prompt instead of every tool's schema on every call. */

const TASK = "t1";

function mcpWith(
  servers: Array<{ name: string; description: string | null; toolCount: number }>,
  tools: Array<{ qualifiedName: string; serverName: string; description: string; inputSchema: unknown }>,
): ResolvedMcp {
  return { tools, definitions: [], needsApproval: new Set(), problems: [], servers } as never;
}

beforeEach(async () => {
  resetDatabase();
  resetListeners();
  await db.insert(schema.users).values({
    id: "u1", email: "u@x.com", passwordHash: "x",
    instanceRole: "user", status: "active", createdAt: Date.now(),
  });
  await db.insert(schema.projects).values({
    id: "p1", ownerUserId: "u1", ownerOrgId: null, name: "P", slug: "p",
    repoUrl: null, branch: null, instructions: null,
    defaultModelId: null, defaultTier: null, spendCapUsd: null, createdAt: Date.now(),
  });
  await db.insert(schema.tasks).values({
    id: TASK, projectId: "p1", workspaceId: null, nodeId: null, actorUserId: "u1",
    title: "t", prompt: "p", status: "running", model: "m",
    costUsd: 0, inputTokens: 0, outputTokens: 0, error: null,
    startedAt: Date.now(), endedAt: null, createdAt: Date.now(),
  });
});

describe("opening a server", () => {
  test("adds it to the opened set", async () => {
    const mcp = mcpWith(
      [{ name: "web_tools", description: "IP, websites and domains", toolCount: 1 }],
      [{ qualifiedName: "web_tools__dns_lookup", serverName: "web_tools", description: "", inputSchema: {} }],
    );
    const opened = new Set<string>();

    await listMcpToolsCall(TASK, { id: "c1", name: "list_mcp_tools", argumentsJson: '{"server":"web_tools"}' }, mcp, opened);

    expect(opened.has("web_tools")).toBe(true);
  });

  test("the result names the tool by its real, callable name", async () => {
    const mcp = mcpWith(
      [{ name: "web_tools", description: null, toolCount: 1 }],
      [{ qualifiedName: "web_tools__dns_lookup", serverName: "web_tools", description: "Resolve a hostname", inputSchema: { properties: { hostname: {} } } }],
    );

    await listMcpToolsCall(TASK, { id: "c1", name: "list_mcp_tools", argumentsJson: '{"server":"web_tools"}' }, mcp, new Set());

    const events = await replay(TASK);
    const result = events.find((e) => e.kind === "tool_result") as { output: string } | undefined;
    expect(result?.output).toContain("web_tools__dns_lookup(hostname)");
  });

  test("an unknown server is not opened, and says what does exist", async () => {
    const mcp = mcpWith([{ name: "web_tools", description: null, toolCount: 1 }], []);
    const opened = new Set<string>();

    await listMcpToolsCall(TASK, { id: "c1", name: "list_mcp_tools", argumentsJson: '{"server":"nope"}' }, mcp, opened);

    expect(opened.size).toBe(0);
    const events = await replay(TASK);
    const result = events.find((e) => e.kind === "tool_result") as { ok: boolean; output: string } | undefined;
    expect(result?.ok).toBe(false);
    expect(result?.output).toContain("web_tools");
  });

  test("records the call under its own name, for the transcript", async () => {
    const mcp = mcpWith([{ name: "web_tools", description: null, toolCount: 0 }], []);
    await listMcpToolsCall(TASK, { id: "c1", name: "list_mcp_tools", argumentsJson: '{"server":"web_tools"}' }, mcp, new Set());

    const events = await replay(TASK);
    const call = events.find((e) => e.kind === "tool_call") as { tool: string } | undefined;
    expect(call?.tool).toBe("list_mcp_tools");
  });
});
