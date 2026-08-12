import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { encryptSecret, decryptSecret } from "./crypto";

/* Instance settings.
 *
 * Read on nearly every email send, changed almost never, so they are cached
 * with an explicit invalidation on write rather than re-read constantly.
 *
 * Secret values are encrypted with the same AES-256-GCM as provider keys, and
 * there is deliberately no API path that returns one. The interface shows
 * whether a password is set, never what it is — same rule as everywhere else
 * in this codebase. */

export const SECRET_KEYS = new Set(["smtp.password"]);

export interface SmtpSettings {
  host: string;
  port: number;
  /* "tls" connects over TLS from the start (usually 465); "starttls" upgrades
     a plain connection (usually 587); "none" is plaintext, for a local relay. */
  security: "tls" | "starttls" | "none";
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

let cache: Map<string, string | null> | undefined;

export function invalidateSettings(): void {
  cache = undefined;
}

async function load(): Promise<Map<string, string | null>> {
  if (cache) return cache;

  const rows = await db.select().from(schema.instanceSettings);
  const map = new Map<string, string | null>();

  for (const row of rows) {
    if (row.secret && row.value) {
      try {
        map.set(row.key, decryptSecret(row.value));
      } catch {
        /* A value that will not decrypt means MAESTRO_SECRET_KEY changed.
           Treating it as unset is the only safe reading — the alternative is
           handing a corrupted string to an SMTP server as a password. */
        console.error(`[settings] could not decrypt ${row.key}; treating it as unset`);
        map.set(row.key, null);
      }
    } else {
      map.set(row.key, row.value);
    }
  }

  cache = map;
  return map;
}

export async function get(key: string): Promise<string | null> {
  return (await load()).get(key) ?? null;
}

export async function setMany(
  values: Record<string, string | null>,
  updatedBy: string,
): Promise<void> {
  for (const [key, raw] of Object.entries(values)) {
    const isSecret = SECRET_KEYS.has(key);
    /* An empty string means "clear it"; undefined never reaches here. */
    const stored = raw === null || raw === "" ? null : isSecret ? encryptSecret(raw) : raw;

    await db
      .insert(schema.instanceSettings)
      .values({
        key,
        value: stored,
        secret: isSecret,
        updatedAt: Date.now(),
        updatedBy,
      })
      .onConflictDoUpdate({
        target: schema.instanceSettings.key,
        set: { value: stored, secret: isSecret, updatedAt: Date.now(), updatedBy },
      });
  }

  invalidateSettings();
}

export async function smtpSettings(): Promise<SmtpSettings | null> {
  const values = await load();

  const host = values.get("smtp.host");
  const fromAddress = values.get("smtp.from_address");

  /* Without a host and a from address there is nothing to send with, and a
     half-configured server should fail at configuration time rather than at
     the moment someone needs a password reset. */
  if (!host || !fromAddress) return null;

  return {
    host,
    port: Number(values.get("smtp.port") ?? 587),
    security: (values.get("smtp.security") as SmtpSettings["security"]) ?? "starttls",
    username: values.get("smtp.username") ?? "",
    password: values.get("smtp.password") ?? "",
    fromAddress,
    fromName: values.get("smtp.from_name") ?? "Maestro",
  };
}

/* What the interface is allowed to see: everything except the password, which
   is reported only as set or not. */
export async function publicSettings() {
  const values = await load();
  return {
    smtp: {
      host: values.get("smtp.host") ?? "",
      port: values.get("smtp.port") ?? "587",
      security: values.get("smtp.security") ?? "starttls",
      username: values.get("smtp.username") ?? "",
      passwordSet: Boolean(values.get("smtp.password")),
      fromAddress: values.get("smtp.from_address") ?? "",
      fromName: values.get("smtp.from_name") ?? "Maestro",
    },
    registration: {
      /* Open registration is off after the first account. This lets an admin
         reopen it deliberately, or restrict it to one email domain. */
      open: values.get("registration.open") === "true",
      allowedDomain: values.get("registration.allowed_domain") ?? "",
    },
  };
}

export async function registrationPolicy(): Promise<{ open: boolean; allowedDomain: string }> {
  const values = await load();
  return {
    open: values.get("registration.open") === "true",
    allowedDomain: values.get("registration.allowed_domain") ?? "",
  };
}

/* Used by tests and by the settings route to drop rows wholesale. */
export async function clear(keys: string[]): Promise<void> {
  await db.delete(schema.instanceSettings).where(inArray(schema.instanceSettings.key, keys));
  invalidateSettings();
}

export async function isConfigured(key: string): Promise<boolean> {
  const [row] = await db
    .select({ value: schema.instanceSettings.value })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.key, key))
    .limit(1);
  return Boolean(row?.value);
}
