#!/usr/bin/env bun
/* Drives a headless Chromium over the DevTools protocol.
 *
 * Screenshotting with --screenshot only ever captures a first paint, which is
 * useless for anything behind a click. This navigates, runs a snippet in the
 * page, and captures what is actually on screen afterwards — so an interactive
 * flow can be verified rather than assumed.
 *
 *   bun run scripts/drive.ts <url> <out.png> [js-to-run] [wait-ms]
 */

const [url, out, script = "", waitMs = "1200"] = process.argv.slice(2);

if (!url || !out) {
  console.error("usage: drive.ts <url> <out.png> [js] [waitMs]");
  process.exit(1);
}

const profile = `/tmp/maestro-drive-${crypto.randomUUID().slice(0, 8)}`;
const port = 9200 + Math.floor(Math.random() * 500);

const chrome = Bun.spawn(
  [
    "chromium",
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,1000",
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);

async function endpoint(): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const body = (await res.json()) as { webSocketDebuggerUrl: string };
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
    } catch {
      /* Not listening yet. */
    }
    await Bun.sleep(200);
  }
  throw new Error("Chromium never opened its debugging port.");
}

const socket = new WebSocket(await endpoint());
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

let nextId = 1;
const pending = new Map<number, (result: any) => void>();

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String((event as MessageEvent).data));
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)!(message.result);
    pending.delete(message.id);
  }
});

function send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
  const id = nextId++;
  return new Promise<any>((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Page.navigate", { url }, sessionId);

/* Give the app time to mount and settle before touching it. */
await Bun.sleep(Number(waitMs));

if (script) {
  const result = await send(
    "Runtime.evaluate",
    { expression: script, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result?.exceptionDetails) {
    console.error("script threw:", result.exceptionDetails.text);
  } else if (result?.result?.value !== undefined) {
    console.log("script returned:", JSON.stringify(result.result.value));
  }
  await Bun.sleep(Number(waitMs));
}

const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
await Bun.write(out, Buffer.from(shot.data, "base64"));
console.log(`captured ${out}`);

socket.close();
chrome.kill();
await Bun.spawn(["rm", "-rf", profile]).exited;
