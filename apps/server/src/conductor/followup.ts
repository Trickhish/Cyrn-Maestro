import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "../db";
import { askConductor } from "./runner";
import { loadThread, remember } from "./thread";
import type { Actor } from "../lib/auth";

/* Closing the loop on dispatched work, on the server.
 *
 * This used to live in the browser: the chat polled the task list and asked a
 * follow-up question when something it had dispatched went terminal. That made
 * the report a property of having the tab open — close it and the completion
 * was never noticed, reload at the wrong moment and it was noticed twice.
 *
 * So the trigger moved to where the task actually finishes. A task the
 * Conductor dispatched carries the thread it came from; when it ends, this runs
 * a silent turn and writes the answer into that thread. Nothing is waiting on
 * it. If a browser has the conversation open it sees the message on its next
 * poll; if not, it is simply there on the next load. */

const TERMINAL = ["completed", "failed", "cancelled"] as const;

/* Claiming a follow-up: flip the flag, and only proceed if this call is the one
   that flipped it.
 *
 * The model call takes seconds and the flag is the only thing standing between
 * one report and several — `finish()` can be reached more than once for the
 * same task, and a boot sweep looks at rows a live trigger may also be holding.
 * A conditional UPDATE is atomic in SQLite, so the loser sees no rows changed
 * and returns. */
async function claim(taskId: string): Promise<boolean> {
  const claimed = await db
    .update(schema.tasks)
    .set({ conductorFollowedUp: true })
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.conductorFollowedUp, false)))
    .returning({ id: schema.tasks.id });

  return claimed.length > 0;
}

/* Reports on one finished task, if it was the Conductor that dispatched it.
   Safe to call for any task and at any time: everything that does not need a
   report returns quietly. Never throws — it runs detached, so a rejection here
   would be an unhandled one. */
export async function followUpOnTask(taskId: string): Promise<void> {
  try {
    const [task] = await db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        status: schema.tasks.status,
        actorId: schema.tasks.conductorActorId,
        threadProjectId: schema.tasks.conductorProjectId,
        followedUp: schema.tasks.conductorFollowedUp,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1);

    /* A human dispatched it, it is not finished, or someone got here first. */
    if (!task?.actorId || task.followedUp) return;
    if (!TERMINAL.includes(task.status as (typeof TERMINAL)[number])) return;

    const [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        instanceRole: schema.users.instanceRole,
      })
      .from(schema.users)
      .where(eq(schema.users.id, task.actorId))
      .limit(1);

    /* The account is gone — there is no thread left to report into, and no one
       whose permissions the turn could legitimately run under. */
    if (!user) return;

    if (!(await claim(taskId))) return;

    const actor: Actor = {
      id: user.id,
      email: user.email,
      instanceRole: user.instanceRole,
    };

    const history = (await loadThread(actor.id, task.threadProjectId)).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    /* The same question the browser used to ask, and silent for the same
       reason: the answer belongs in the thread, the prompt does not — nobody
       typed it. */
    const turn = await askConductor(
      actor,
      history,
      `The task [${task.id}] you dispatched has finished with status "${task.status}". ` +
        `Read what it actually did with get_task and tell me the outcome in a sentence or two. ` +
        `If it failed or the work needs another pass, say so and what you would dispatch next.`,
      undefined,
      { projectId: task.threadProjectId ?? undefined },
    );

    await remember(
      actor.id,
      task.threadProjectId,
      "assistant",
      turn.text,
      turn.model,
      turn.toolCalls.map((call) => ({ name: call.name, args: call.args, result: call.result })),
    );
  } catch (err) {
    /* A failed report must not take anything else down with it — the task is
       already finished and recorded, and this is commentary on it. The claim
       stays set deliberately: retrying a turn that threw tends to throw again,
       and a silent duplicate later is worse than a missing note. */
    console.error(`conductor follow-up failed for task ${taskId}`, err);
  }
}

/* Tasks that ended while the server was down.
 *
 * The trigger fires in-process, so a task that went terminal during a restart —
 * including one the recovery sweep itself fails — would never be reported.
 * Called at boot, after recovery has settled the active rows. */
export async function followUpOnMissed(): Promise<number> {
  const pending = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        isNotNull(schema.tasks.conductorActorId),
        eq(schema.tasks.conductorFollowedUp, false),
        inArray(schema.tasks.status, [...TERMINAL]),
      ),
    );

  /* Sequential on purpose: each is a model call, and a fleet that finished ten
     tasks during a restart should not open ten at once on boot. */
  for (const task of pending) await followUpOnTask(task.id);

  return pending.length;
}
