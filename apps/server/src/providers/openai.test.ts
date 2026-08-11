import { expect, test, describe } from "bun:test";
import { OpenAICompatibleAdapter } from "./openai";
import { ProviderError, type StreamEvent } from "./types";

/* Builds a response whose body is delivered in exactly the chunks given, so a
   test can put a break anywhere — mid-line, mid-JSON, mid-character. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function adapterFor(response: Response | (() => Response)) {
  return new OpenAICompatibleAdapter({
    baseUrl: "https://provider.test/v1",
    apiKey: "test-key",
    fetchImpl: (async () => (typeof response === "function" ? response() : response)) as typeof fetch,
  });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

const req = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

describe("streaming text", () => {
  test("concatenates deltas in order", async () => {
    const events = await collect(
      adapterFor(
        sseResponse([
          frame({ choices: [{ delta: { content: "Hel" } }] }),
          frame({ choices: [{ delta: { content: "lo" } }] }),
          frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ]),
      ).stream(req),
    );

    const text = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
    expect(text).toBe("Hello");
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
  });

  /* A network read can end mid-line. Parsing each chunk independently is the
     classic way streaming clients drop or duplicate output. */
  test("survives a chunk boundary in the middle of a line", async () => {
    const whole = frame({ choices: [{ delta: { content: "split" } }] });
    const cut = Math.floor(whole.length / 2);
    const events = await collect(
      adapterFor(sseResponse([whole.slice(0, cut), whole.slice(cut)])).stream(req),
    );
    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("split");
  });

  /* A boundary inside a multi-byte character yields U+FFFD unless the decoder
     is told the stream continues. */
  test("survives a chunk boundary inside a multi-byte character", async () => {
    const whole = new TextEncoder().encode(frame({ choices: [{ delta: { content: "café ☕" } }] }));
    const at = whole.indexOf(0xe2); // first byte of ☕
    const encoder = new TextDecoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(whole.slice(0, at + 1));
        c.enqueue(whole.slice(at + 1));
        c.close();
      },
    });
    void encoder;

    const adapter = adapterFor(
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const events = await collect(adapter.stream(req));
    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("café ☕");
  });

  test("ignores keep-alive comments and blank lines", async () => {
    const events = await collect(
      adapterFor(
        sseResponse([": keep-alive\n\n", frame({ choices: [{ delta: { content: "x" } }] }), "\n\n"]),
      ).stream(req),
    );
    expect(events.filter((e) => e.type === "text")).toHaveLength(1);
  });

  test("skips a malformed frame rather than aborting the completion", async () => {
    const events = await collect(
      adapterFor(
        sseResponse([
          "data: {not json\n\n",
          frame({ choices: [{ delta: { content: "survived" } }] }),
        ]),
      ).stream(req),
    );
    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("survived");
  });

  test("stops at [DONE] and ignores anything after it", async () => {
    const events = await collect(
      adapterFor(
        sseResponse([
          frame({ choices: [{ delta: { content: "a" } }] }),
          "data: [DONE]\n\n",
          frame({ choices: [{ delta: { content: "should not appear" } }] }),
        ]),
      ).stream(req),
    );
    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("a");
  });
});

describe("tool calls", () => {
  /* The important one. `arguments` streams as partial JSON across many frames,
     and identity arrives only on the first. Emitting per fragment, or letting a
     later empty id overwrite the real one, breaks tool use entirely. */
  test("assembles arguments streamed across many fragments", async () => {
    const events = await collect(
      adapterFor(
        sseResponse([
          frame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_abc", function: { name: "read_file", arguments: "" } },
                  ],
                },
              },
            ],
          }),
          frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] }),
          frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a' } }] } }] }),
          frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] } }] }),
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]),
      ).stream(req),
    );

    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0].call.id).toBe("call_abc");
    expect(calls[0].call.name).toBe("read_file");
    expect(JSON.parse(calls[0].call.argumentsJson)).toEqual({ path: "a.ts" });
  });

  test("keeps parallel calls separate and in index order", async () => {
    const events = await collect(
      adapterFor(
        sseResponse([
          frame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 1, id: "second", function: { name: "grep", arguments: '{"pattern":"x"}' } },
                    { index: 0, id: "first", function: { name: "list_dir", arguments: "{}" } },
                  ],
                },
              },
            ],
          }),
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]),
      ).stream(req),
    );

    const calls = events.filter((e) => e.type === "tool_call").map((e) => e.call.id);
    expect(calls).toEqual(["first", "second"]);
  });

  /* Some servers emit tool calls but leave finish_reason as "stop". Trusting
     the flag would end the turn with calls outstanding and hang the task. */
  test("reports tool_calls even when the server says stop", async () => {
    const events = await collect(
      adapterFor(
        sseResponse([
          frame({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, id: "c", function: { name: "bash", arguments: "{}" } }] },
                finish_reason: "stop",
              },
            ],
          }),
        ]),
      ).stream(req),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "tool_calls" });
  });

  test("defaults empty arguments to a valid empty object", async () => {
    const events = await collect(
      adapterFor(
        sseResponse([
          frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "list_dir" } }] } }] }),
        ]),
      ).stream(req),
    );
    const call = events.find((e) => e.type === "tool_call")!;
    expect(() => JSON.parse(call.call.argumentsJson)).not.toThrow();
  });
});

describe("usage", () => {
  test("reports what the provider sends", async () => {
    const events = await collect(
      adapterFor(
        sseResponse([
          frame({ choices: [{ delta: { content: "x" } }] }),
          frame({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 34 } }),
        ]),
      ).stream(req),
    );
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      inputTokens: 120,
      outputTokens: 34,
    });
  });

  /* Not every OpenAI-compatible server honours stream_options. A missing usage
     event must not leave the loop waiting for one that never comes. */
  test("still emits a usage event when the provider sends none", async () => {
    const events = await collect(
      adapterFor(sseResponse([frame({ choices: [{ delta: { content: "x" } }] })])).stream(req),
    );
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });
});

describe("errors", () => {
  test("401 is not retryable and points at the key", async () => {
    const adapter = adapterFor(
      () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    );
    try {
      await collect(adapter.stream(req));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(false);
      expect((err as ProviderError).message).toContain("MAESTRO_PROVIDER_API_KEY");
    }
  });

  test("404 points at the base URL", async () => {
    const adapter = adapterFor(() => new Response("no route", { status: 404 }));
    try {
      await collect(adapter.stream(req));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).message).toContain("/v1");
    }
  });

  test("429 and 5xx are retryable", async () => {
    for (const status of [429, 500, 503]) {
      const adapter = adapterFor(() => new Response("busy", { status }));
      try {
        await collect(adapter.stream(req));
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as ProviderError).retryable).toBe(true);
      }
    }
  });
});

describe("request shape", () => {
  test("an assistant turn with only tool calls sends null content", async () => {
    let sent: Record<string, unknown> | undefined;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://provider.test/v1",
      apiKey: "k",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return sseResponse([]);
      }) as unknown as typeof fetch,
    });

    await collect(
      adapter.stream({
        model: "m",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "bash", argumentsJson: '{"command":"ls"}' }],
          },
          { role: "tool", toolCallId: "c1", content: "a.ts" },
        ],
      }),
    );

    const messages = sent!.messages as Array<Record<string, unknown>>;
    expect(messages[1].content).toBeNull();
    expect(messages[1].tool_calls).toHaveLength(1);
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });
});
