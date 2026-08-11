import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { sql } from "drizzle-orm";
import { join } from "node:path";
import { db } from "../db";
import { config } from "../config";

/* Every DB-touching test file calls resetDatabase() in beforeAll.
 *
 * Because bun test shares one process, files also share one database. Rather
 * than pretend otherwise, each file starts from a known-empty schema. Tests
 * within a file may depend on order; tests across files may not. */

let migrated = false;

export function resetDatabase(): void {
  /* If the preload were ever removed or bypassed, this is what stops a test
     run from quietly truncating the development database. */
  if (!config.dbPath.includes("maestro-test-")) {
    throw new Error(
      `Refusing to reset a database outside a test directory: ${config.dbPath}\n` +
        `Tests must run through bunfig.toml's preload (bun test), which points ` +
        `MAESTRO_DB at a temporary file.`,
    );
  }

  if (!migrated) {
    migrate(db, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
    migrated = true;
  }

  /* Order matters only in that children go before parents; foreign keys are on. */
  for (const table of [
    "task_events",
    "approvals",
    "tasks",
    "workspaces",
    "enrollment_tokens",
    "models",
    "provider_connections",
    "nodes",
    "projects",
    "sessions",
    "users",
  ]) {
    db.run(sql.raw(`DELETE FROM ${table}`));
  }
}

export const jsonPost = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function cookieFrom(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/* Registers the first account and returns its session cookie. Most tests need
   a signed-in owner before they can assert anything interesting. */
export async function signedInOwner(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  email = "owner@example.com",
  password = "a-long-enough-password",
): Promise<{ cookie: string; actor: { id: string; email: string } }> {
  const res = await app.request("/api/auth/register", jsonPost({ email, password }));
  if (res.status !== 201) {
    throw new Error(`Could not register the test owner: ${res.status} ${await res.text()}`);
  }
  return { cookie: cookieFrom(res), actor: (await res.json()).actor };
}
