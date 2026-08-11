import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "node:path";
import { db } from "./index";
import { config } from "../config";

/* Applies any pending migrations in drizzle/. Safe to run on every boot —
   already-applied migrations are skipped by the journal table drizzle keeps. */

migrate(db, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
console.log(`migrations applied → ${config.dbPath}`);
