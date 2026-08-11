import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/* Preloaded before any test module — see bunfig.toml.
 *
 * bun test runs every file in one process with a shared module registry, so
 * config.ts is evaluated once, by whichever test file imports it first. A test
 * that sets MAESTRO_DB at its own top level therefore loses the race and
 * silently writes to the development database. Setting it here is the only
 * point that reliably precedes every import.
 *
 * A fresh directory per run also means a crashed run cannot leave state that
 * makes the next one pass or fail for the wrong reason. */

const dir = mkdtempSync(join(tmpdir(), "maestro-test-"));

process.env.MAESTRO_DB = join(dir, "test.db");
process.env.MAESTRO_SECRET_KEY = "0".repeat(64);
process.env.MAESTRO_PUBLIC_URL = "http://localhost:3000";
process.env.MAESTRO_INSECURE_COOKIES = "1";

/* Never inherit a real provider key from the developer's .env — a test that
   accidentally reaches the network should fail, not spend money. */
delete process.env.MAESTRO_PROVIDER_API_KEY;
