import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { db, schema } from "../db";

/* The Conductor's conversation, as the server holds it.
 *
 * Factored out of the HTTP route because the route is no longer the only thing
 * that writes here: a task finishing reports back into the same thread from a
 * background job, with no request in flight and possibly no browser open. Both
 * paths have to agree on what a thread is and how it is trimmed, so they share
 * this rather than each keeping their own copy. */

/* How much of a thread is kept.
 *
 * Enough that the Conductor knows what you just asked it to do, and that
 * reopening the page continues a conversation rather than starting one. Not so
 * much that it becomes an archive: old turns cost tokens on every call and
 * answer questions nobody is asking any more. Trimmed on write, so the bound
 * holds without a sweeper. */
export const THREAD_LIMIT = 40;

/* One thread per person per project. The global screen is its own, with a null
   projectId — and `isNull` rather than `eq(null)`, which matches nothing. */
export const thread = (actorId: string, projectId?: string | null) =>
  and(
    eq(schema.conductorMessages.actorUserId, actorId),
    projectId
      ? eq(schema.conductorMessages.projectId, projectId)
      : isNull(schema.conductorMessages.projectId),
  );

export async function loadThread(actorId: string, projectId?: string | null) {
  const rows = await db
    .select()
    .from(schema.conductorMessages)
    .where(thread(actorId, projectId))
    .orderBy(desc(schema.conductorMessages.createdAt))
    .limit(THREAD_LIMIT);
  return rows.reverse();
}

export async function remember(
  actorId: string,
  projectId: string | null | undefined,
  role: "user" | "assistant",
  content: string,
  model?: string,
  tools?: unknown,
) {
  if (!content.trim()) return;

  await db.insert(schema.conductorMessages).values({
    id: crypto.randomUUID(),
    projectId: projectId ?? null,
    actorUserId: actorId,
    role,
    content,
    model: model ?? null,
    tools: tools ?? null,
    createdAt: Date.now(),
  });

  /* Trim by id rather than a date cutoff: two turns in the same millisecond
     are ordinary, and a cutoff would keep or drop both. */
  const keep = await db
    .select({ id: schema.conductorMessages.id })
    .from(schema.conductorMessages)
    .where(thread(actorId, projectId))
    .orderBy(desc(schema.conductorMessages.createdAt))
    .limit(THREAD_LIMIT);

  /* Anything outside the newest THREAD_LIMIT goes. Only worth a query when the
     thread is actually at the bound. */
  if (keep.length === THREAD_LIMIT) {
    await db
      .delete(schema.conductorMessages)
      .where(
        and(
          thread(actorId, projectId),
          notInArray(
            schema.conductorMessages.id,
            keep.map((k) => k.id),
          ),
        ),
      );
  }
}
