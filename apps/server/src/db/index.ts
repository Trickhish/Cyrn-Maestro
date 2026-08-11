import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";
import * as schema from "./schema";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const sqlite = new Database(config.dbPath, { create: true });

/* WAL so a long-running agent loop writing events does not block reads from the
   UI stream. The busy timeout covers the brief writer overlap that still exists
   under WAL; without it a concurrent write throws SQLITE_BUSY instead of waiting. */
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA busy_timeout = 5000");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec("PRAGMA synchronous = NORMAL");

export const db = drizzle(sqlite, { schema });
export { schema };
