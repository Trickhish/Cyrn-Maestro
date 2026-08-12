import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { listTools, callTool } from "./client";

/* Our MCP client against a server that behaves the way the Infinity MCP
 * gateway documents itself (https://mcp.dury.dev/docs.md):
 *
 *   - JSON-RPC over POST, answered as Server-Sent Events rather than bare JSON
 *   - requests without `text/event-stream` in Accept are rejected outright
 *   - stateless: no initialize handshake is required and no session id is
 *     issued, so nothing may depend on one coming back
 *   - a bearer token on every request, including the initialize the SDK sends
 *
 * The point is to catch a mismatch between our transport and that contract
 * here, where the failure names itself, rather than as an unexplained empty
 * tool list in a task. */

const TOKEN = "imcp_0123456789abcdef";

let server: ReturnType<typeof Bun.serve>;
let base: string;
const seen: { accept?: string; auth?: string; methods: string[] } = { methods: [] };

function sse(id: unknown, result: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      /* The gateway 404s an unknown service; a trailing slash is what its own
         documentation uses throughout. */
      if (url.pathname !== "/graphhopper/") {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }

      const auth = req.headers.get("authorization") ?? undefined;
      if (auth !== `Bearer ${TOKEN}`) {
        return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
      }

      /* A stateless server has no standing stream to open and no session to
         end, so both optional verbs are refused. The client has to cope with
         that rather than depend on either. */
      if (req.method === "GET" || req.method === "DELETE") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405 });
      }

      const accept = req.headers.get("accept") ?? "";
      seen.accept = accept;
      seen.auth = auth;

      if (!accept.includes("text/event-stream")) {
        return new Response(JSON.stringify({ error: "Not Acceptable" }), { status: 406 });
      }

      const rpc = (await req.json()) as { id?: unknown; method: string; params?: any };
      seen.methods.push(rpc.method);

      switch (rpc.method) {
        case "initialize":
          return sse(rpc.id, {
            /* Stateless: no session id, deliberately. */
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "graphhopper", version: "1.0.0" },
          });

        case "notifications/initialized":
          return new Response(null, { status: 202 });

        case "tools/list":
          return sse(rpc.id, {
            tools: [
              {
                name: "geocode",
                description: "Turn a place name into coordinates",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" }, limit: { type: "number" } },
                  required: ["query"],
                },
              },
            ],
          });

        case "tools/call":
          if (rpc.params?.name !== "geocode") {
            return sse(rpc.id, { content: [{ type: "text", text: "no such tool" }], isError: true });
          }
          /* Text parts on this gateway carry JSON as a string, which is what
             the model ends up reading. */
          return sse(rpc.id, {
            content: [
              {
                type: "text",
                text: JSON.stringify({ hits: [{ name: rpc.params.arguments.query, lat: 48.85 }] }),
              },
            ],
          });

        default:
          return sse(rpc.id, {});
      }
    },
  });

  base = `http://127.0.0.1:${server.port}/graphhopper/`;
});

afterAll(() => {
  server.stop(true);
});

const config = (over: Record<string, unknown> = {}) => ({
  name: "graphhopper",
  url: base,
  headers: { Authorization: `Bearer ${TOKEN}` },
  ...over,
});

describe("an aggregating gateway's transport", () => {
  test("lists tools over SSE-framed JSON-RPC", async () => {
    const tools = await listTools(config());

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      qualifiedName: "graphhopper__geocode",
      toolName: "geocode",
      serverName: "graphhopper",
      description: "Turn a place name into coordinates",
    });
  });

  test("asks for event-stream, which this transport requires", async () => {
    await listTools(config());
    expect(seen.accept).toContain("text/event-stream");
  });

  test("sends the bearer token on the handshake, not only on later calls", async () => {
    seen.methods.length = 0;
    await listTools(config());

    expect(seen.methods[0]).toBe("initialize");
    expect(seen.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("calls a tool and returns its text payload", async () => {
    const result = await callTool(config(), "geocode", { query: "Paris", limit: 1 });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ hits: [{ name: "Paris", lat: 48.85 }] });
  });

  test("reports a tool-level error as a failure rather than as output", async () => {
    const result = await callTool(config(), "nope", {});
    expect(result.ok).toBe(false);
  });

  test("a missing key fails with something that names the server", async () => {
    await expect(listTools(config({ headers: {} }))).rejects.toMatchObject({
      serverName: "graphhopper",
    });
  });

  test("a wrong service path fails rather than hanging", async () => {
    await expect(
      listTools(config({ url: `http://127.0.0.1:${server.port}/deezer/` })),
    ).rejects.toThrow();
  });
});
