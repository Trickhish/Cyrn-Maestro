import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { decryptSecret } from "../lib/crypto";
import { listTools, callTool, unqualify, toolDefinitionFor, type McpTool, type HttpServerConfig } from "./client";
import type { ToolDefinition } from "../providers/types";

/* Resolving a project's MCP tools for one task.
 *
 * v0.5 connects server-side HTTP servers. Node-side stdio placement is stored
 * and shown, but not yet spawned — the honest position is that it is configured
 * and inert rather than quietly pretending to work. */

export interface ResolvedMcp {
  tools: McpTool[];
  definitions: ToolDefinition[];
  /* Which tools need a human before they run, by qualified name. */
  needsApproval: Set<string>;
  /* Reported rather than swallowed: a configured server that will not connect
     should be visible in the thread, not an unexplained absence of tools. */
  problems: Array<{ server: string; message: string }>;
}

const EMPTY: ResolvedMcp = {
  tools: [],
  definitions: [],
  needsApproval: new Set(),
  problems: [],
};

function configFor(row: typeof schema.mcpServers.$inferSelect): HttpServerConfig {
  let headers: Record<string, string> | undefined;

  if (row.encryptedHeaders) {
    try {
      headers = JSON.parse(decryptSecret(row.encryptedHeaders));
    } catch {
      /* A header set that will not decrypt means the secret key changed.
         Connecting without it will fail with the server's own 401, which is a
         clearer signal than a decryption stack trace. */
    }
  }

  return {
    name: row.name,
    url: row.url ?? "",
    headers,
    toolAllowlist: row.toolAllowlist ?? [],
  };
}

export async function resolveMcpTools(projectId: string): Promise<ResolvedMcp> {
  const rows = await db
    .select()
    .from(schema.mcpServers)
    .where(and(eq(schema.mcpServers.projectId, projectId), eq(schema.mcpServers.enabled, true)));

  if (rows.length === 0) return EMPTY;

  const tools: McpTool[] = [];
  const needsApproval = new Set<string>();
  const problems: ResolvedMcp["problems"] = [];

  for (const row of rows) {
    if (row.approval === "never") continue;

    if (row.placement === "node") {
      problems.push({
        server: row.name,
        message:
          "Node-side MCP servers are configured but not yet started. Its tools are unavailable for now.",
      });
      continue;
    }

    try {
      const found = await listTools(configFor(row));
      tools.push(...found);

      if (row.approval === "ask") {
        for (const tool of found) needsApproval.add(tool.qualifiedName);
      }

      await db
        .update(schema.mcpServers)
        .set({ lastConnectedAt: Date.now(), lastError: null })
        .where(eq(schema.mcpServers.id, row.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems.push({ server: row.name, message });

      await db
        .update(schema.mcpServers)
        .set({ lastError: message })
        .where(eq(schema.mcpServers.id, row.id));
    }
  }

  return {
    tools,
    definitions: tools.map(toolDefinitionFor),
    needsApproval,
    problems,
  };
}

/* Runs one MCP tool call, resolving which server owns it from the namespace. */
export async function runMcpTool(
  projectId: string,
  qualifiedName: string,
  args: unknown,
): Promise<{ ok: boolean; output: string }> {
  const parsed = unqualify(qualifiedName);
  if (!parsed) {
    return { ok: false, output: `${qualifiedName} is not a known tool.` };
  }

  const [row] = await db
    .select()
    .from(schema.mcpServers)
    .where(
      and(
        eq(schema.mcpServers.projectId, projectId),
        eq(schema.mcpServers.name, parsed.serverName),
        eq(schema.mcpServers.enabled, true),
      ),
    )
    .limit(1);

  if (!row) {
    return { ok: false, output: `There is no MCP server called "${parsed.serverName}" on this project.` };
  }

  /* The allowlist is a boundary, not a display filter. A model that guesses a
     tool name outside it must not reach the server. */
  if (row.toolAllowlist?.length && !row.toolAllowlist.includes(parsed.toolName)) {
    return {
      ok: false,
      output: `${parsed.toolName} is not enabled for ${parsed.serverName} on this project.`,
    };
  }

  if (row.approval === "never") {
    return { ok: false, output: `${parsed.serverName} is set to never run tools.` };
  }

  if (row.placement === "node") {
    return { ok: false, output: "Node-side MCP servers are not started yet." };
  }

  return callTool(configFor(row), parsed.toolName, args);
}

export function isMcpTool(name: string): boolean {
  return unqualify(name) !== null;
}
