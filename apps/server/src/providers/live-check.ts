/* Live smoke check against the configured provider. Not part of `bun test`:
   it needs a real key and the network, and it costs money to run.

     bun run apps/server/src/providers/live-check.ts

   Verifies the two things unit tests with a stubbed fetch cannot: that the
   real endpoint speaks the shape we assume, and that tool calls actually come
   back assembled. */

import { config } from "../config";
import { OpenAICompatibleAdapter } from "./openai";
import { toolDefinitions } from "./gateway";

const baseUrl = config.seedProvider.baseUrl;
const apiKey = config.seedProvider.apiKey;

if (!baseUrl || !apiKey) {
  console.error("Set MAESTRO_PROVIDER_BASE_URL and MAESTRO_PROVIDER_API_KEY in .env first.");
  process.exit(1);
}

const model = process.argv[2] ?? "claude-haiku-4-5-20251001";
const adapter = new OpenAICompatibleAdapter({ baseUrl, apiKey });

console.log(`provider  ${baseUrl}`);
console.log(`model     ${model}\n`);

console.log("1. model list");
const models = await adapter.listModels();
console.log(`   ${models.length} models, e.g. ${models.slice(0, 3).map((m) => m.id).join(", ")}\n`);

console.log("2. probe");
const probe = await adapter.probe(model);
console.log(
  `   ok=${probe.ok}${probe.needsReasoningEffort ? " (needs reasoning_effort)" : ""}${probe.error ? ` — ${probe.error}` : ""}\n`,
);
if (!probe.ok) process.exit(1);

const reasoningEffort = probe.needsReasoningEffort ? ("low" as const) : undefined;

console.log("3. streaming text");
let text = "";
let chunks = 0;
for await (const event of adapter.stream({
  model,
  messages: [{ role: "user", content: "Reply with exactly: streaming works" }],
  maxTokens: 1024,
  reasoningEffort,
})) {
  if (event.type === "text") {
    text += event.delta;
    chunks++;
  }
  if (event.type === "usage") console.log(`   usage  in=${event.inputTokens} out=${event.outputTokens}`);
  if (event.type === "done") console.log(`   finish ${event.finishReason}`);
}
console.log(`   text   ${JSON.stringify(text)} (${chunks} deltas)\n`);

console.log("4. tool calls");
const calls: Array<{ name: string; argumentsJson: string }> = [];
for await (const event of adapter.stream({
  model,
  messages: [
    {
      role: "user",
      content: "Read the file src/auth/session.ts. Use the read_file tool. Do not ask first.",
    },
  ],
  tools: toolDefinitions(),
  maxTokens: 2048,
  reasoningEffort,
})) {
  if (event.type === "tool_call") calls.push(event.call);
  if (event.type === "done") console.log(`   finish ${event.finishReason}`);
}

for (const call of calls) {
  let parsed: unknown;
  let ok = true;
  try {
    parsed = JSON.parse(call.argumentsJson);
  } catch {
    ok = false;
  }
  console.log(`   ${call.name}  args ${ok ? "parse ok" : "PARSE FAILED"}  ${JSON.stringify(parsed)}`);
}

if (calls.length === 0) {
  console.log("   no tool call returned — the model declined, which is not an adapter failure");
}

console.log("\ndone");
