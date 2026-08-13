import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { decryptSecret } from "../lib/crypto";
import { listTools, callTool, unqualify, toolDefinitionFor, type McpTool, type HttpServerConfig } from "./client";
import type { ToolDefinition } from "../providers/types";

/* Resolving the owner's MCP tools for one task.
 *
 * v0.5 connects server-side HTTP servers. Node-side stdio placement is stored
 * and shown, but not yet spawned — the honest position is that it is configured
 * and inert rather than quietly pretending to work. */

export interface ResolvedMcp {
  tools: McpTool[];
  definitions: ToolDefinition[];
  /* One line per connected server, for the prompt. Nine of these cost less
     than a hundred JSON schemas and let the model choose by what a server is
     for rather than by scanning tool names. */
  servers: Array<{ name: string; description: string | null; toolCount: number }>;
  /* Which tools need a human before they run, by qualified name. */
  needsApproval: Set<string>;
  /* Reported rather than swallowed: a configured server that will not connect
     should be visible in the thread, not an unexplained absence of tools. */
  problems: Array<{ server: string; message: string }>;
}

const EMPTY: ResolvedMcp = {
  tools: [],
  definitions: [],
  servers: [],
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

export interface McpOwner {
  ownerUserId?: string | null;
  ownerOrgId?: string | null;
}

function ownedBy(owner: McpOwner) {
  return owner.ownerOrgId
    ? eq(schema.mcpServers.ownerOrgId, owner.ownerOrgId)
    : eq(schema.mcpServers.ownerUserId, owner.ownerUserId!);
}

export async function resolveMcpTools(owner: McpOwner): Promise<ResolvedMcp> {
  if (!owner.ownerOrgId && !owner.ownerUserId) return EMPTY;

  const rows = await db
    .select()
    .from(schema.mcpServers)
    .where(and(ownedBy(owner), eq(schema.mcpServers.enabled, true)));

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
    /* Only servers that actually contributed a tool: a "never" approval or a
       node-placement row was already skipped above and has nothing to offer. */
    servers: rows
      .map((row) => ({
        name: row.name,
        description: row.description,
        toolCount: tools.filter((t) => t.serverName === row.name).length,
      }))
      .filter((s) => s.toolCount > 0),
  };
}

/* Offered instead of every server's tools, the way a skill's one-line summary
 * is offered instead of its full body. Nine servers cost nine lines; their
 * hundred-odd combined tool schemas cost every call, whether or not the task
 * has anything to do with DNS. */
export function mcpPromptSection(mcp: ResolvedMcp): string {
  if (mcp.servers.length === 0) return "";

  const lines = mcp.servers.map(
    (s) => `- ${s.name} (${s.toolCount} tool${s.toolCount === 1 ? "" : "s"})${s.description ? ` — ${s.description}` : ""}`,
  );

  return [
    "MCP servers available. Call list_mcp_tools with a server's name to see what it offers before using it:",
    ...lines,
  ].join("\n");
}

/* Offered whenever any server is connected — the one tool that makes the rest
 * discoverable. Modelled on load_skill: a name in, the real tool list back as
 * text, and the model calls them by their normal qualified name afterward. */
export const LIST_MCP_TOOLS_TOOL = {
  name: "list_mcp_tools",
  description:
    "See the tools one MCP server offers, with their arguments, before calling any of them.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "The server's name, exactly as listed." },
    },
    required: ["server"],
    additionalProperties: false,
  },
} as const;

/* What list_mcp_tools hands back: one line per tool on that server, its real
 * (namespaced) name included so the model calls it correctly afterward — the
 * whole reason the earlier mismatch happened was a name it had to remember
 * rather than one just handed to it. */
export function describeServerTools(mcp: ResolvedMcp, serverName: string): string {
  const known = mcp.tools.filter((t) => t.serverName === serverName);
  if (known.length === 0) {
    const names = mcp.servers.map((s) => s.name);
    return names.includes(serverName)
      ? `${serverName} has no tools available right now.`
      : `No server called "${serverName}". Available: ${names.join(", ") || "none"}.`;
  }

  return known
    .map((t) => {
      const props = (t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
      const args = Object.keys(props).join(", ");
      return `${t.qualifiedName}(${args})${t.description ? ` — ${t.description}` : ""}`;
    })
    .join("\n");
}

/* Runs one MCP tool call, resolving which server owns it from the namespace. */
export async function runMcpTool(
  owner: McpOwner,
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
        ownedBy(owner),
        eq(schema.mcpServers.name, parsed.serverName),
        eq(schema.mcpServers.enabled, true),
      ),
    )
    .limit(1);

  if (!row) {
    return { ok: false, output: `There is no MCP server called "${parsed.serverName}" available here.` };
  }

  /* The allowlist is a boundary, not a display filter. A model that guesses a
     tool name outside it must not reach the server. */
  if (row.toolAllowlist?.length && !row.toolAllowlist.includes(parsed.toolName)) {
    return {
      ok: false,
      output: `${parsed.toolName} is not enabled for ${parsed.serverName}.`,
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
