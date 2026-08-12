import { expect, test, describe } from "bun:test";

/* What a turn dispatched has to come from the tool's own result, not the
 * model's sentence: it does not reliably quote the id back, and a task card
 * the interface only draws when the prose happens to mention one is a card
 * that mostly does not appear. This is that extraction, kept honest. */

/* Mirrors the expression in conductor.routes.ts. */
function dispatchedFrom(toolCalls: Array<{ name: string; result: string }>): string[] {
  return toolCalls.flatMap((call) =>
    call.name === "create_task"
      ? [...call.result.matchAll(/\[([0-9a-f-]{8,})\]/gi)].map((m) => m[1])
      : [],
  );
}

const ID = "5981fbeb-3845-4d16-a903-283f8a56f172";

describe("reading dispatched task ids out of a turn", () => {
  test("finds the id in create_task's result", () => {
    expect(
      dispatchedFrom([{ name: "create_task", result: `Dispatched [${ID}] "Do a thing" to MAIN.SRV on m.` }]),
    ).toEqual([ID]);
  });

  /* The case that broke the feature in practice: the model answered "Task
     dispatched to MAIN.SRV, ask me again shortly" without the id anywhere. */
  test("does not depend on the assistant's prose mentioning it", () => {
    const calls = [{ name: "create_task", result: `Dispatched [${ID}] "Do a thing" to MAIN.SRV on m.` }];
    expect(dispatchedFrom(calls)).toEqual([ID]);
  });

  test("ignores every other tool's result", () => {
    expect(
      dispatchedFrom([
        { name: "get_task", result: `Some task [${ID}]\nstatus: completed` },
        { name: "list_tasks", result: `[${ID}] Do a thing · completed` },
      ]),
    ).toEqual([]);
  });

  test("a refused dispatch contributes nothing", () => {
    expect(
      dispatchedFrom([{ name: "create_task", result: 'No model in "difficult programming" is currently available.' }]),
    ).toEqual([]);
  });

  test("collects one id per dispatch when a turn made several", () => {
    const second = "0ff5e3a2-76c4-48b0-bc07-18fec7caf5ff";
    expect(
      dispatchedFrom([
        { name: "create_task", result: `Dispatched [${ID}] "One" to MAIN.SRV on m.` },
        { name: "list_model_lists", result: "difficult programming — hard things" },
        { name: "create_task", result: `Dispatched [${second}] "Two" to MAIN.SRV on m.` },
      ]),
    ).toEqual([ID, second]);
  });
});
