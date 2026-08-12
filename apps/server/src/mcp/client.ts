import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ToolDefinition } from "../providers/types";

/* Talking to a remote MCP server.
 *
 * Connections are made per task rather than held open. A long-lived pool would
 * be faster, but a task can run for half an hour and a server can restart
 * underneath it — reconnecting on demand fails at a point where the error can
 * be attributed to something, rather than mid-turn for no visible reason.
 *
 * Tools are namespaced as <server>__<tool>. Two servers exposing "search"
 * would otherwise collide, and the model would call one meaning the other. */

export const NAMESPACE_SEPARATOR = "__";

export class McpError extends Error {
  constructor(
    message: string,
    readonly serverName: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpTool {
  /* The name the model sees. */
  qualifiedName: string;
  /* The name the server knows. */
  toolName: string;
  serverName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function qualify(serverName: string, toolName: string): string {
  return `${serverName}${NAMESPACE_SEPARATOR}${toolName}`;
}

export function unqualify(qualified: string): { serverName: string; toolName: string } | null {
  const at = qualified.indexOf(NAMESPACE_SEPARATOR);
  if (at === -1) return null;
  return {
    serverName: qualified.slice(0, at),
    toolName: qualified.slice(at + NAMESPACE_SEPARATOR.length),
  };
}

export interface HttpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  toolAllowlist?: string[];
}

async function connect(config: HttpServerConfig): Promise<Client> {
  const client = new Client(
    { name: "maestro", version: "0.5.0" },
    { capabilities: {} },
  );

  const url = new URL(config.url);
  const requestInit = config.headers ? { headers: config.headers } : undefined;

  /* Streamable HTTP is the current transport; SSE is the one a lot of deployed
     servers still speak. Trying the new one first and falling back means a
     server on either works without the user having to know which. */
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
    return client;
  } catch (streamableError) {
    try {
      await client.connect(new SSEClientTransport(url, { requestInit }));
      return client;
    } catch {
      /* The first error is the more informative one: an SSE failure against a
         streamable server is a red herring. */
      throw new McpError(
        streamableError instanceof Error ? streamableError.message : String(streamableError),
        config.name,
      );
    }
  }
}

export async function listTools(config: HttpServerConfig): Promise<McpTool[]> {
  const client = await connect(config);

  try {
    const { tools } = await client.listTools();

    return tools
      .filter(
        (tool) =>
          !config.toolAllowlist?.length || config.toolAllowlist.includes(tool.name),
      )
      .map((tool) => ({
        qualifiedName: qualify(config.name, tool.name),
        toolName: tool.name,
        serverName: config.name,
        description: tool.description ?? `${tool.name} on ${config.name}`,
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<
          string,
          unknown
        >,
      }));
  } finally {
    await client.close().catch(() => {});
  }
}

export async function callTool(
  config: HttpServerConfig,
  toolName: string,
  args: unknown,
): Promise<{ ok: boolean; output: string }> {
  const client = await connect(config);

  try {
    const result = await client.callTool({
      name: toolName,
      arguments: (args ?? {}) as Record<string, unknown>,
    });

    /* MCP returns content blocks; the model wants text. Anything that is not
       text is described rather than dropped, so the model knows something came
       back it cannot read. */
    const parts = (result.content as Array<Record<string, unknown>> | undefined) ?? [];
    const text = parts
      .map((part) =>
        part.type === "text"
          ? String(part.text ?? "")
          : `[${String(part.type)} content, not shown]`,
      )
      .join("\n")
      .trim();

    return {
      /* isError is how MCP reports a tool-level failure, as distinct from a
         transport failure. Both reach the model as a failed result. */
      ok: !result.isError,
      output: text || (result.isError ? "The tool reported an error with no message." : "(no output)"),
    };
  } catch (err) {
    return {
      ok: false,
      output: `${config.name} could not run ${toolName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/* The definition handed to the model. */
export function toolDefinitionFor(tool: McpTool): ToolDefinition {
  return {
    name: tool.qualifiedName,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}
