import { inArray, eq } from "drizzle-orm";
import { newId } from "@maestro/protocol";
import { db, schema } from "../db";
import { append } from "./events";
import { isRunning } from "./runner";
import { sendToNode, noteReleased } from "../nodes/registry";

/* Orphan recovery.
 *
 * A task's loop lives in the server process. If that process dies mid-task —
 * a restart, a crash, a deploy — the row stays "running" forever: nothing
 * resumes it, the UI shows a spinner that never resolves, and the node keeps
 * the slot allocated until it is told otherwise.
 *
 * v0.1 cannot resume such a task: the model call it was waiting on is gone and
 * the tool result it expected will never arrive. So it is failed honestly,
 * with a reason that says what happened, rather than left to look alive. */

const ACTIVE = ["queued", "assigned", "running", "awaiting_approval"] as const;

export async function recoverOrphanedTasks(): Promise<number> {
  const active = await db
    .select({
      id: schema.tasks.id,
      nodeId: schema.tasks.nodeId,
      status: schema.tasks.status,
    })
    .from(schema.tasks)
    .where(inArray(schema.tasks.status, [...ACTIVE]));

  /* On a fresh boot no loop is running, so every active row is an orphan. The
     isRunning check matters when this is called again later — a periodic sweep,
     or after a node reconnects — where some tasks legitimately have a loop. */
  const orphans = active.filter((task) => !isRunning(task.id));

  for (const task of orphans) {
    const detail =
      task.status === "awaiting_approval"
        ? "The server restarted while this task was waiting for approval, so it could not be resumed."
        : "The server restarted while this task was running, so it could not be resumed.";

    await db
      .update(schema.tasks)
      .set({ status: "failed", endedAt: Date.now(), error: detail })
      .where(eq(schema.tasks.id, task.id));

    append(task.id, { kind: "status", status: "failed", detail });

    /* Free the slot on the node too. A node that reconnects still believes it
       is running these, and would refuse new work once it filled up. */
    if (task.nodeId) {
      noteReleased(task.nodeId, task.id);
      sendToNode(task.nodeId, {
        type: "task.release",
        id: newId(),
        taskId: task.id,
        status: "failed",
      });
    }
  }

  return orphans.length;
}

/* Called when a node registers, since that is the moment its slot bookkeeping
   can be reconciled: anything it thinks it is running that we do not is stale. */
export async function reconcileNode(nodeId: string, nodeBelievesRunning: string[]): Promise<void> {
  if (nodeBelievesRunning.length === 0) return;

  const known = await db
    .select({ id: schema.tasks.id, status: schema.tasks.status })
    .from(schema.tasks)
    .where(inArray(schema.tasks.id, nodeBelievesRunning));

  const byId = new Map(known.map((t) => [t.id, t.status]));

  for (const taskId of nodeBelievesRunning) {
    const status = byId.get(taskId);
    const stale = !status || !ACTIVE.includes(status as (typeof ACTIVE)[number]) || !isRunning(taskId);

    if (stale) {
      noteReleased(nodeId, taskId);
      sendToNode(nodeId, {
        type: "task.release",
        id: newId(),
        taskId,
        status: "failed",
      });
    }
  }
}
