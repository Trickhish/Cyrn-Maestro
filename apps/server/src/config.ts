import { join } from "node:path";
import { loadRootEnv } from "./lib/env";

/* One place that reads the environment, so a missing variable fails loudly at
   boot rather than at the first request that happens to need it. */

loadRootEnv();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.\n` +
        `  MAESTRO_SECRET_KEY can be generated with:  openssl rand -hex 32`,
    );
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "127.0.0.1",
  publicUrl: process.env.MAESTRO_PUBLIC_URL ?? "http://localhost:3000",

  dbPath: process.env.MAESTRO_DB ?? join(import.meta.dir, "../../../data/maestro.db"),
  webDist: join(import.meta.dir, "../../web/dist"),

  /* Cookies get Secure unless we are plainly on http://localhost — otherwise a
     production deploy behind TLS would be one forgotten flag from leaking the
     session over plaintext. */
  get secureCookies(): boolean {
    if (process.env.MAESTRO_INSECURE_COOKIES === "1") return false;
    return !this.publicUrl.startsWith("http://localhost");
  },

  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  enrollmentTtlMs: 15 * 60 * 1000,
  heartbeatIntervalMs: 20_000,
  nodeOfflineAfterMs: 60_000,

  taskLimits: {
    wallClockMs: 30 * 60 * 1000,
    maxToolCalls: 200,
    /* What the model is allowed to see from one tool result. The node reports
       the true size separately so the UI can say what was cut. */
    maxToolOutputBytes: 30_000,
  },

  secretKey(): string {
    return required("MAESTRO_SECRET_KEY");
  },

  /* Seeded into the owner's provider list on first boot when present, so a
     fresh instance is usable without a trip through the settings UI. */
  seedProvider: {
    baseUrl: process.env.MAESTRO_PROVIDER_BASE_URL,
    apiKey: process.env.MAESTRO_PROVIDER_API_KEY,
  },
};
