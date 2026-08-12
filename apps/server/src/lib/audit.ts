import { db, schema } from "../db";
import type { Actor } from "./auth";

/* The audit log.
 *
 * Append-only and never deleted through the interface: a log that can be
 * edited by the people it records is not evidence of anything.
 *
 * The actor's email is stored alongside their id because the id becomes
 * meaningless once the user row is gone, and "who did this" is exactly the
 * question the log exists to answer months later. */

export async function record(
  orgId: string | null,
  actor: Actor | null,
  action: string,
  target?: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      orgId,
      actorUserId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      action,
      target: target ?? null,
      metadata: metadata ?? null,
      at: Date.now(),
    });
  } catch (err) {
    /* An audit failure must never break the action it was recording — losing
       one line is bad, failing a role change because of it is worse. It is
       logged loudly so the gap is visible. */
    console.error("[audit] failed to record", action, err);
  }
}
