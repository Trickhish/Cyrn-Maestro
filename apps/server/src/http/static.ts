import { file } from "bun";
import { join, normalize } from "node:path";
import { config } from "../config";

/* Serves the built webapp. Kept separate from the API so the SPA fallback can
   never swallow an unmatched /api route and answer it with index.html — an
   API 404 has to look like one to the client. */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot)]) ?? "application/octet-stream";
}

export async function serveStatic(pathname: string): Promise<Response> {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const path = join(config.webDist, clean);

  if (path.startsWith(config.webDist)) {
    const asset = file(path);
    if (await asset.exists()) {
      return new Response(asset, {
        headers: {
          "content-type": contentType(path),
          /* Hashed assets are immutable; index.html must revalidate so a
             redeploy shows up on the next load, not the next cache expiry. */
          "cache-control": clean.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }
  }

  const index = file(join(config.webDist, "index.html"));
  if (!(await index.exists())) {
    return new Response("Not built yet. Run: bun run build\n", {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  }
  return new Response(index, {
    headers: { "content-type": CONTENT_TYPES[".html"], "cache-control": "no-cache" },
  });
}
