import { Hono } from "hono";
import { z } from "zod";
import { publicSettings, setMany, smtpSettings } from "../lib/settings";
import { verifyMail, sendMail, testMessage, MailNotConfigured } from "../lib/mail";
import { record } from "../lib/audit";
import { BadRequest, requireActor, type Env } from "./context";
import type { Actor } from "../lib/auth";

export const instanceRoutes = new Hono<Env>();

/* Instance settings are about running the server, not about the work inside
   it, so they sit at the instance-admin level rather than under any
   organization. This is the one place that role means anything beyond
   administering accounts. */
function requireInstanceAdmin(c: Parameters<typeof requireActor>[0]): Actor {
  const actor = requireActor(c);
  if (actor.instanceRole !== "instance_admin") {
    /* 404 rather than 403, same as everywhere else: a non-admin has no reason
       to learn that this endpoint exists. */
    throw new BadRequest("Not found.");
  }
  return actor;
}

instanceRoutes.get("/settings", async (c) => {
  requireInstanceAdmin(c);
  return c.json(await publicSettings());
});

const SmtpInput = z.object({
  host: z.string().max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  security: z.enum(["tls", "starttls", "none"]).optional(),
  username: z.string().max(255).optional(),
  /* Omitted means "leave the stored one alone"; an empty string clears it.
     Without that distinction, saving the form would wipe the password every
     time, because the interface never receives it back to resubmit. */
  password: z.string().max(512).optional(),
  fromAddress: z.email("Enter the address messages should come from.").optional(),
  fromName: z.string().max(120).optional(),
});

const SettingsInput = z.object({
  smtp: SmtpInput.optional(),
  registration: z
    .object({
      open: z.boolean().optional(),
      allowedDomain: z.string().max(255).optional(),
    })
    .optional(),
});

instanceRoutes.put("/settings", async (c) => {
  const actor = requireInstanceAdmin(c);

  const parsed = SettingsInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new BadRequest("Check the form.", z.flattenError(parsed.error).fieldErrors);
  }

  const values: Record<string, string | null> = {};
  const { smtp, registration } = parsed.data;

  if (smtp) {
    if (smtp.host !== undefined) values["smtp.host"] = smtp.host.trim();
    if (smtp.port !== undefined) values["smtp.port"] = String(smtp.port);
    if (smtp.security !== undefined) values["smtp.security"] = smtp.security;
    if (smtp.username !== undefined) values["smtp.username"] = smtp.username.trim();
    if (smtp.password !== undefined) values["smtp.password"] = smtp.password;
    if (smtp.fromAddress !== undefined) values["smtp.from_address"] = smtp.fromAddress.trim();
    if (smtp.fromName !== undefined) values["smtp.from_name"] = smtp.fromName.trim();
  }

  if (registration) {
    if (registration.open !== undefined) values["registration.open"] = String(registration.open);
    if (registration.allowedDomain !== undefined) {
      values["registration.allowed_domain"] = registration.allowedDomain.trim().toLowerCase();
    }
  }

  await setMany(values, actor.id);

  /* The changed keys are recorded, never their values — an SMTP password in an
     audit log would defeat encrypting it in the first place. */
  await record(null, actor, "instance.settings_changed", null, { keys: Object.keys(values) });

  return c.json(await publicSettings());
});

/* Proves the settings work before anything depends on them. Deliberately a
   separate step from saving: a reset email that silently fails to send is a
   locked-out user with no way to find out why. */
instanceRoutes.post("/settings/smtp/test", async (c) => {
  const actor = requireInstanceAdmin(c);

  const parsed = z
    .object({ to: z.email("Enter an address to send the test to.") })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Enter an address to send the test to.");

  const settings = await smtpSettings();
  if (!settings) {
    return c.json(
      { ok: false, error: "Set at least a host and a from address, and save, before testing." },
      400,
    );
  }

  const verified = await verifyMail(settings);
  if (!verified.ok) {
    await record(null, actor, "instance.smtp_test_failed", parsed.data.to);
    return c.json({ ok: false, stage: "connect", error: verified.error }, 502);
  }

  try {
    await sendMail(testMessage(parsed.data.to));
  } catch (err) {
    await record(null, actor, "instance.smtp_test_failed", parsed.data.to);
    return c.json(
      {
        ok: false,
        stage: "send",
        error: err instanceof MailNotConfigured ? err.message : (err as Error).message,
      },
      502,
    );
  }

  await record(null, actor, "instance.smtp_test_sent", parsed.data.to);
  return c.json({ ok: true });
});
