import { expect, test, describe, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { encryptSecret } from "../lib/crypto";
import { resetListeners, replay } from "./events";
import { streamWithFailover } from "./failover";
import { ProviderError, type StreamEvent, type ProviderAdapter } from "../providers/types";
import type { ResolvedProvider } from "../providers/gateway";

/* Failover has two ways to be wrong that a passing task would hide:
 *
 *   retrying something that will never succeed, which spends money to produce
 *   the same error twice; and
 *
 *   switching models without saying so, which leaves a thread whose cost and
 *   output nobody can account for. */

const USER = "u1";
const PROJECT = "p1";
const TASK = "t1";

function adapterThat(behaviour: () => AsyncGenerator<StreamEvent>): ProviderAdapter {
  return {
    kind: "test",
    listModels: async () => [],
    probe: async () => ({ ok: true }),
    stream: behaviour,
  };
}

function ok(text: string): ProviderAdapter {
  return adapterThat(async function* () {
    yield { type: "text", delta: text };
    yield { type: "usage", inputTokens: 1, outputTokens: 1 };
    yield { type: "done", finishReason: "stop" };
  });
}

function fails(status: number, retryable: boolean): ProviderAdapter {
  return adapterThat(async function* () {
    throw new ProviderError(`boom ${status}`, status, retryable);
    /* eslint-disable-next-line no-unreachable */
    yield { type: "done", finishReason: "stop" };
  });
}

function provider(model: string, adapter: ProviderAdapter): ResolvedProvider {
  return { connectionId: "c1", name: "Test", model, adapter };
}

async function seed(models: string[]) {
  const now = Date.now();
  await db.insert(schema.users).values({
    id: USER, email: "u@x.com", passwordHash: "x",
    instanceRole: "user", status: "active", createdAt: now,
  });
  await db.insert(schema.projects).values({
    id: PROJECT, ownerUserId: USER, ownerOrgId: null, name: "P", slug: "p",
    repoUrl: null, branch: null, instructions: null,
    defaultModelId: null, defaultTier: null, spendCapUsd: null, createdAt: now,
  });
  await db.insert(schema.tasks).values({
    id: TASK, projectId: PROJECT, workspaceId: null, nodeId: null, actorUserId: USER,
    title: "t", prompt: "p", status: "running", model: models[0],
    costUsd: 0, inputTokens: 0, outputTokens: 0, error: null,
    startedAt: now, endedAt: null, createdAt: now,
  });

  const providerId = crypto.randomUUID();
  await db.insert(schema.providerConnections).values({
    id: providerId, ownerUserId: USER, ownerOrgId: null, name: "Test",
    kind: "openai_compatible", baseUrl: "https://x.test/v1",
    encryptedKey: encryptSecret("k"), enabled: true,
    lastHealthAt: null, lastHealthOk: null, createdAt: now,
  });
  for (const modelId of models) {
    await db.insert(schema.models).values({
      id: crypto.randomUUID(), providerId, modelId, tier: "standard", tierSource: "inferred",
      contextWindow: null, priceInPerMTok: null, priceOutPerMTok: null,
      enabled: true, probedAt: now, probeOk: true, probeError: null,
      needsReasoningEffort: false,
    });
  }
}

const context = {
  owner: { ownerUserId: USER, ownerOrgId: null },
  taskId: TASK,
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
};

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

beforeEach(async () => {
  resetDatabase();
  resetListeners();
});

describe("when nothing goes wrong", () => {
  test("the events pass straight through", async () => {
    await seed(["model-a"]);
    let current = provider("model-a", ok("hello"));

    const events = await drain(
      streamWithFailover(() => current, (p) => (current = p), context, new AbortController().signal),
    );

    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("hello");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("no switch is announced", async () => {
    await seed(["model-a"]);
    let current = provider("model-a", ok("hello"));

    await drain(
      streamWithFailover(() => current, (p) => (current = p), context, new AbortController().signal),
    );

    const events = await replay(TASK);
    expect(events.some((e) => e.kind === "assistant_message")).toBe(false);
  });
});

describe("a retryable failure", () => {
  test("moves to the next candidate and succeeds", async () => {
    await seed(["model-a", "model-b"]);

    let current = provider("model-a", fails(429, true));
    const events = await drain(
      streamWithFailover(
        () => current,
        (next) => {
          /* resolveProvider returns the real row; swap in a working adapter so
             the second attempt can succeed. */
          current = { ...next, adapter: ok("recovered") };
        },
        context,
        new AbortController().signal,
      ),
    );

    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("recovered");
  });

  /* Silent failover produces a thread whose model badge and cost cannot be
     reconciled with what actually ran. */
  test("says so in the thread", async () => {
    await seed(["model-a", "model-b"]);

    let current = provider("model-a", fails(429, true));
    await drain(
      streamWithFailover(
        () => current,
        (next) => (current = { ...next, adapter: ok("recovered") }),
        context,
        new AbortController().signal,
      ),
    );

    const events = await replay(TASK);
    const said = events.find((e) => e.kind === "assistant_message") as { text: string } | undefined;
    expect(said?.text).toContain("Switched to");

    const logged = events.find((e) => e.kind === "log") as { chunk: string } | undefined;
    expect(logged?.chunk).toContain("unavailable");
  });

  test("gives up once every candidate has failed", async () => {
    await seed(["model-a", "model-b"]);

    let current = provider("model-a", fails(503, true));
    await expect(
      drain(
        streamWithFailover(
          () => current,
          (next) => (current = { ...next, adapter: fails(503, true) }),
          context,
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/boom 503/);
  });
});

describe("a failure that will not be fixed by retrying", () => {
  /* A 400 means the request itself is wrong. Sending it to a second model
     produces the same error and spends money doing it. */
  test("is not retried", async () => {
    await seed(["model-a", "model-b"]);

    let attempts = 0;
    let current = provider(
      "model-a",
      adapterThat(async function* () {
        attempts++;
        throw new ProviderError("bad request", 400, false);
        /* eslint-disable-next-line no-unreachable */
        yield { type: "done", finishReason: "stop" };
      }),
    );

    await expect(
      drain(
        streamWithFailover(() => current, (p) => (current = p), context, new AbortController().signal),
      ),
    ).rejects.toThrow(/bad request/);

    expect(attempts).toBe(1);
  });

  test("does not announce a switch that never happened", async () => {
    await seed(["model-a", "model-b"]);
    let current = provider("model-a", fails(401, false));

    await drain(
      streamWithFailover(() => current, (p) => (current = p), context, new AbortController().signal),
    ).catch(() => {});

    const events = await replay(TASK);
    expect(events.some((e) => e.kind === "assistant_message")).toBe(false);
  });
});

describe("a pinned model", () => {
  /* Model lists are the ordered-fallback-chain feature. A direct pin is a
     promise about which model and what it costs — silently substituting
     another one breaks that promise even if the substitute would work. */
  test("is not failed over even when another candidate would succeed", async () => {
    await seed(["model-a", "model-b"]);

    let current = provider("model-a", fails(503, true));
    await expect(
      drain(
        streamWithFailover(
          () => current,
          (next) => (current = { ...next, adapter: ok("recovered") }),
          { ...context, pinned: true },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/boom 503/);
  });

  test("does not announce a switch that never happened", async () => {
    await seed(["model-a", "model-b"]);
    let current = provider("model-a", fails(503, true));

    await drain(
      streamWithFailover(
        () => current,
        (next) => (current = { ...next, adapter: ok("recovered") }),
        { ...context, pinned: true },
        new AbortController().signal,
      ),
    ).catch(() => {});

    const events = await replay(TASK);
    expect(events.some((e) => e.kind === "assistant_message")).toBe(false);
  });
});

describe("cancellation", () => {
  test("an aborted run stops rather than failing over", async () => {
    await seed(["model-a", "model-b"]);

    const controller = new AbortController();
    controller.abort();

    let current = provider("model-a", ok("never"));
    const events = await drain(
      streamWithFailover(() => current, (p) => (current = p), context, controller.signal),
    );

    expect(events).toHaveLength(0);
  });
});
