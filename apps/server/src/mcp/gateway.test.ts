import { expect, test, describe, afterEach } from "bun:test";
import { discoverGateway, gatewayBase, GatewayError } from "./gateway";

/* Discovery against a stand-in gateway.
 *
 * The shape under test is Infinity MCP's `GET /api/services`, which is a vendor
 * convention rather than part of MCP — so what matters is that a well-formed
 * answer is read correctly and a malformed one produces a sentence someone can
 * act on, rather than a parse error from somewhere deep inside. */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function respondWith(status: number, body: unknown, contentType = "application/json") {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    seen.url = String(input);
    seen.auth = new Headers(init?.headers).get("authorization") ?? undefined;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": contentType },
    });
  }) as unknown as typeof fetch;
}

const seen: { url?: string; auth?: string } = {};

const TWO_SERVICES = {
  services: [
    {
      id: "graphhopper",
      name: "GraphHopper",
      description: "Routing, geocoding, isochrone & distance matrix",
      url: "https://mcp.dury.dev/graphhopper",
      requires_account: false,
      connected: true,
    },
    {
      id: "deezer",
      name: "Deezer",
      description: "Music library management & streaming",
      url: "https://mcp.dury.dev/deezer",
      requires_account: true,
      connected: false,
    },
  ],
};

describe("gatewayBase", () => {
  test("keeps a bare origin", () => {
    expect(gatewayBase("https://mcp.dury.dev")).toBe("https://mcp.dury.dev");
  });

  test("trims a trailing slash", () => {
    expect(gatewayBase("https://mcp.dury.dev/")).toBe("https://mcp.dury.dev");
  });

  /* Someone reading the documentation is as likely to copy one of these as the
     bare origin, and all three mean the same gateway. */
  test("trims the discovery and docs paths people paste", () => {
    expect(gatewayBase("https://mcp.dury.dev/api/services")).toBe("https://mcp.dury.dev");
    expect(gatewayBase("https://mcp.dury.dev/api/me")).toBe("https://mcp.dury.dev");
    expect(gatewayBase("https://mcp.dury.dev/docs.md")).toBe("https://mcp.dury.dev");
  });

  test("keeps a gateway mounted under a path", () => {
    expect(gatewayBase("https://example.com/mcp/api/services")).toBe("https://example.com/mcp");
  });

  test("refuses plaintext to a remote host, because the key is in a header", () => {
    expect(() => gatewayBase("http://mcp.dury.dev")).toThrow(GatewayError);
  });

  test("allows plaintext to this machine, where there is no network to sniff", () => {
    expect(gatewayBase("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  });

  test("rejects something that is not a URL", () => {
    expect(() => gatewayBase("mcp.dury.dev")).toThrow(GatewayError);
  });
});

describe("discoverGateway", () => {
  test("reads the service list and sends the key as a bearer token", async () => {
    respondWith(200, TWO_SERVICES);

    const { base, services } = await discoverGateway("https://mcp.dury.dev", "imcp_abc");

    expect(seen.url).toBe("https://mcp.dury.dev/api/services");
    expect(seen.auth).toBe("Bearer imcp_abc");
    expect(base).toBe("https://mcp.dury.dev");
    expect(services.map((s) => s.id)).toEqual(["graphhopper", "deezer"]);
  });

  /* The gateway's own examples POST to a trailing slash. Without it the server
     may redirect, and a redirected POST is where an Authorization header
     quietly goes missing. */
  test("gives every service URL a trailing slash", async () => {
    respondWith(200, TWO_SERVICES);
    const { services } = await discoverGateway("https://mcp.dury.dev", "k");
    expect(services[0]!.url).toBe("https://mcp.dury.dev/graphhopper/");
  });

  test("carries through whether an account still needs linking", async () => {
    respondWith(200, TWO_SERVICES);
    const { services } = await discoverGateway("https://mcp.dury.dev", "k");

    expect(services[0]).toMatchObject({ requiresAccount: false, connected: true });
    expect(services[1]).toMatchObject({ requiresAccount: true, connected: false });
  });

  test("builds a URL for a service that does not state one", async () => {
    respondWith(200, { services: [{ id: "web_tools" }] });
    const { services } = await discoverGateway("https://mcp.dury.dev", "k");

    expect(services[0]!.url).toBe("https://mcp.dury.dev/web_tools/");
    /* Nothing to link means nothing to be disconnected from. */
    expect(services[0]!.connected).toBe(true);
    expect(services[0]!.name).toBe("web_tools");
  });

  test("ignores an entry with no id rather than inventing one", async () => {
    respondWith(200, { services: [{ name: "nameless" }, { id: "ok" }] });
    const { services } = await discoverGateway("https://mcp.dury.dev", "k");
    expect(services.map((s) => s.id)).toEqual(["ok"]);
  });

  test("explains a rejected key without guessing which way it was rejected", async () => {
    respondWith(401, { error: "invalid_token" });
    await expect(discoverGateway("https://mcp.dury.dev", "bad")).rejects.toThrow(
      /rejected that key/,
    );
  });

  test("reports any other status as coming from the gateway", async () => {
    respondWith(503, "");
    await expect(discoverGateway("https://mcp.dury.dev", "k")).rejects.toThrow(/503/);
  });

  test("says so when the URL answers with something that is not JSON", async () => {
    respondWith(200, "<!doctype html><title>hello</title>", "text/html");
    await expect(discoverGateway("https://mcp.dury.dev", "k")).rejects.toThrow(/not answer with JSON/);
  });

  test("says so when JSON comes back without a service list", async () => {
    respondWith(200, { message: "hi" });
    await expect(discoverGateway("https://mcp.dury.dev", "k")).rejects.toThrow(
      /not.*a list of services/,
    );
  });

  test("reports a host that cannot be reached at all", async () => {
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    await expect(discoverGateway("https://nope.invalid", "k")).rejects.toThrow(/Could not reach/);
  });
});
