import { expect, test, describe, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { append, replay, replayForDisplay, subscribe, lastSeq, conversationFrom, resetListeners } from "./events";

const TASK = "task-1";

beforeEach(async () => {
  resetDatabase();
  resetListeners();

  const now = Date.now();
  await db.insert(schema.users).values({
    id: "u1", email: "u@x.com", passwordHash: "x", instanceRole: "user", status: "active", createdAt: now,
  });
  await db.insert(schema.projects).values({
    id: "p1", ownerUserId: "u1", ownerOrgId: null, name: "P", slug: "p",
    repoUrl: null, branch: "main", instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: now,
  });
  await db.insert(schema.tasks).values({
    id: TASK, projectId: "p1", workspaceId: null, nodeId: null, actorUserId: "u1",
    title: "T", prompt: "do it", status: "queued", model: null,
    costUsd: 0, inputTokens: 0, outputTokens: 0, error: null, startedAt: null, endedAt: null, createdAt: now,
  });
});

describe("sequence numbers", () => {
  test("start at 1 and increase without gaps", () => {
    for (let i = 0; i < 5; i++) append(TASK, { kind: "status", status: "running" });
    expect(replay(TASK).then((e) => e.map((x) => x.seq))).resolves.toEqual([1, 2, 3, 4, 5]);
  });

  /* The UI resumes a dropped stream by asking for everything after its last
     seq, so a gap silently loses a tool call rather than obviously breaking. */
  test("stay gap-free under concurrent appends", async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() => append(TASK, { kind: "log", stream: "stdout", chunk: `${i}` })),
      ),
    );

    const seqs = (await replay(TASK)).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  test("are per task, not global", async () => {
    const now = Date.now();
    await db.insert(schema.tasks).values({
      id: "task-2", projectId: "p1", workspaceId: null, nodeId: null, actorUserId: "u1",
      title: "T2", prompt: "x", status: "queued", model: null,
      costUsd: 0, inputTokens: 0, outputTokens: 0, error: null, startedAt: null, endedAt: null, createdAt: now,
    });

    append(TASK, { kind: "status", status: "running" });
    const second = append("task-2", { kind: "status", status: "running" });
    expect(second.seq).toBe(1);
  });
});

describe("subscriptions", () => {
  test("deliver events as they are appended", () => {
    const seen: string[] = [];
    subscribe(TASK, (e) => seen.push(e.kind));

    append(TASK, { kind: "status", status: "running" });
    append(TASK, { kind: "log", stream: "stdout", chunk: "x" });

    expect(seen).toEqual(["status", "log"]);
  });

  test("unsubscribing stops delivery", () => {
    const seen: string[] = [];
    const stop = subscribe(TASK, (e) => seen.push(e.kind));
    append(TASK, { kind: "status", status: "running" });
    stop();
    append(TASK, { kind: "status", status: "completed" });
    expect(seen).toHaveLength(1);
  });

  /* One browser tab throwing must not stop another tab from receiving events,
     nor kill the agent loop that is appending them. */
  test("a throwing listener does not break the others", () => {
    const seen: string[] = [];
    subscribe(TASK, () => {
      throw new Error("boom");
    });
    subscribe(TASK, (e) => seen.push(e.kind));

    expect(() => append(TASK, { kind: "status", status: "running" })).not.toThrow();
    expect(seen).toEqual(["status"]);
  });
});

describe("replay", () => {
  test("resumes after a given sequence number", async () => {
    append(TASK, { kind: "status", status: "queued" });
    append(TASK, { kind: "status", status: "running" });
    append(TASK, { kind: "status", status: "completed" });

    const after = await replay(TASK, 1);
    expect(after.map((e) => e.seq)).toEqual([2, 3]);
  });

  /* Deltas exist only for live rendering; the assistant_message that follows
     holds the same text. Replaying both would double every sentence. */
  test("display replay omits streaming deltas", async () => {
    append(TASK, { kind: "assistant_delta", text: "Hel" });
    append(TASK, { kind: "assistant_delta", text: "lo" });
    append(TASK, { kind: "assistant_message", text: "Hello", model: "m" });

    expect((await replayForDisplay(TASK)).map((e) => e.kind)).toEqual(["assistant_message"]);
    expect((await replay(TASK))).toHaveLength(3);
  });

  test("lastSeq reports where a client should resume", async () => {
    expect(await lastSeq(TASK)).toBe(0);
    append(TASK, { kind: "status", status: "running" });
    expect(await lastSeq(TASK)).toBe(1);
  });
});

describe("rebuilding the conversation for the model", () => {
  test("pairs tool calls with their results in order", async () => {
    append(TASK, { kind: "user_message", text: "read a.ts" });
    append(TASK, { kind: "assistant_message", text: "", model: "m" });
    append(TASK, { kind: "tool_call", callId: "c1", tool: "read_file", args: { path: "a.ts" }, summary: "a.ts" });
    append(TASK, { kind: "tool_result", callId: "c1", ok: true, output: "contents" });

    const messages = await conversationFrom(TASK);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect((messages[1] as any).toolCalls[0].id).toBe("c1");
    expect(messages[2]).toMatchObject({ role: "tool", toolCallId: "c1", content: "contents" });
  });

  /* Dropping a failed result would strand the call with no matching tool
     message, which most providers reject outright — and the model needs to see
     the error to correct itself. */
  test("a failed tool result is still fed back", async () => {
    append(TASK, { kind: "tool_call", callId: "c1", tool: "bash", args: {}, summary: "x" });
    append(TASK, { kind: "tool_result", callId: "c1", ok: false, output: "command not found" });

    const messages = await conversationFrom(TASK);
    expect(messages.at(-1)).toMatchObject({ role: "tool", content: "command not found" });
  });

  test("an empty output still produces a tool message", async () => {
    append(TASK, { kind: "tool_call", callId: "c1", tool: "bash", args: {}, summary: "x" });
    append(TASK, { kind: "tool_result", callId: "c1", ok: true, output: "" });

    const messages = await conversationFrom(TASK);
    expect(messages.at(-1)).toMatchObject({ role: "tool" });
    expect((messages.at(-1) as any).content.length).toBeGreaterThan(0);
  });

  /* A message typed mid-run is appended when typed and must appear in order
     when the next turn is built. */
  test("a steering message lands in sequence", async () => {
    append(TASK, { kind: "user_message", text: "first" });
    append(TASK, { kind: "assistant_message", text: "working", model: "m" });
    append(TASK, { kind: "user_message", text: "actually, stop", queued: true });

    const messages = await conversationFrom(TASK);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages.at(-1)).toMatchObject({ content: "actually, stop" });
  });

  test("status and usage events are not sent to the model", async () => {
    append(TASK, { kind: "user_message", text: "hi" });
    append(TASK, { kind: "status", status: "running" });
    append(TASK, { kind: "usage", model: "m", inputTokens: 1, outputTokens: 2, costUsd: 0 });

    expect(await conversationFrom(TASK)).toHaveLength(1);
  });
});
