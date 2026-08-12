/* Connecting to an MCP gateway — one host fronting several MCP services.
 *
 * Each service behind a gateway is an ordinary MCP endpoint, so nothing here
 * touches the runtime: a service imported from a gateway becomes a normal row
 * and is listed and called by exactly the same code as a hand-added server.
 * This file only exists to save someone from adding nine servers by hand and
 * pasting the same key into each one.
 *
 * Enumerating what a gateway hosts is not part of MCP, so it is a vendor
 * convention. The one implemented here is Infinity MCP's `GET /api/services`
 * (https://mcp.dury.dev/docs.md). The parser is deliberately loose: a gateway
 * that answers with the same shape works without being named. */

export interface GatewayService {
  id: string;
  name: string;
  description: string;
  url: string;
  /* Whether it needs a third-party account linked at the gateway. */
  requiresAccount: boolean;
  /* Whether that link is in place. False means the tools will load but fail. */
  connected: boolean;
}

export class GatewayError extends Error {}

/* The gateway's own base, with any discovery or service path trimmed off, so
   pasting either the gateway root or one of its documented URLs works. */
export function gatewayBase(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new GatewayError("That is not a URL.");
  }

  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    /* The key travels in a header; plaintext would hand it to the network. */
    throw new GatewayError("Use https for a gateway that is not on this machine.");
  }

  url.pathname = url.pathname.replace(/\/(api\/(services|me)|docs\.md)\/?$/, "");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/* Services are POSTed to with a trailing slash throughout the gateway's own
   documentation. Without it a server may redirect, and a redirected POST is
   where an Authorization header quietly goes missing. */
function serviceUrl(base: string, raw: unknown, id: string): string {
  const url = typeof raw === "string" && raw.length > 0 ? raw : `${base}/${id}`;
  return url.endsWith("/") ? url : `${url}/`;
}

export async function discoverGateway(
  baseUrl: string,
  token: string,
): Promise<{ base: string; services: GatewayService[] }> {
  const base = gatewayBase(baseUrl);

  let res: Response;
  try {
    res = await fetch(`${base}/api/services`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new GatewayError(
      `Could not reach ${base}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 401 || res.status === 403) {
    /* The gateway deliberately does not say which of these it is, so neither
       do we — guessing out loud would be wrong as often as right. */
    throw new GatewayError(
      "The gateway rejected that key. It may be revoked, or scoped to nothing this account can reach.",
    );
  }
  if (!res.ok) {
    throw new GatewayError(`The gateway answered ${res.status} when asked what it hosts.`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GatewayError("The gateway did not answer with JSON. Is that its base URL?");
  }

  const raw = (body as { services?: unknown })?.services;
  if (!Array.isArray(raw)) {
    throw new GatewayError(
      "That URL answered, but not with a list of services. It may not be an MCP gateway.",
    );
  }

  const services: GatewayService[] = [];
  for (const entry of raw) {
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;

    services.push({
      id,
      name: typeof item.name === "string" ? item.name : id,
      description: typeof item.description === "string" ? item.description : "",
      url: serviceUrl(base, item.url, id),
      requiresAccount: item.requires_account === true,
      /* Absent means nothing to link, so nothing to be disconnected from. */
      connected: item.connected !== false,
    });
  }

  return { base, services };
}
