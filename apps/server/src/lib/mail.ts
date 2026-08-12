import nodemailer from "nodemailer";
import { config } from "../config";
import { smtpSettings, type SmtpSettings } from "./settings";

/* Sending mail.
 *
 * nodemailer rather than a hand-rolled SMTP client: unlike TOTP, which is a
 * short algorithm with published test vectors, SMTP is a stateful protocol
 * whose difficulty is interoperating with a decade of server quirks — STARTTLS
 * upgrades, AUTH mechanism negotiation, dot-stuffing. The failure mode of
 * getting it slightly wrong is silent non-delivery against one provider, which
 * is exactly the kind of bug nobody finds until it matters.
 *
 * Every message is sent as both plain text and HTML. Some clients render only
 * one, and a password reset that arrives blank is worse than no email. */

export class MailNotConfigured extends Error {
  constructor() {
    super("No SMTP server is configured. An instance administrator can set one up in Instance settings.");
    this.name = "MailNotConfigured";
  }
}

export interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function transportFor(settings: SmtpSettings) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    /* `secure` means TLS from the moment the socket opens, which is port 465.
       On 587 the connection starts plain and upgrades, which nodemailer does
       automatically when secure is false and the server advertises STARTTLS. */
    secure: settings.security === "tls",
    ...(settings.security === "none"
      ? { ignoreTLS: true }
      : settings.security === "starttls"
        ? { requireTLS: true }
        : {}),
    ...(settings.username
      ? { auth: { user: settings.username, pass: settings.password } }
      : {}),
    /* A misconfigured host should fail in seconds, not hang a request until
       the browser gives up. */
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export async function sendMail(message: Message): Promise<void> {
  const settings = await smtpSettings();
  if (!settings) throw new MailNotConfigured();

  const transport = transportFor(settings);

  try {
    await transport.sendMail({
      from: { name: settings.fromName, address: settings.fromAddress },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } finally {
    transport.close();
  }
}

/* Proves the settings work before anyone depends on them. Returns the SMTP
   server's own error rather than a generic failure, because "authentication
   failed" and "connection refused" need different fixes. */
export async function verifyMail(settings: SmtpSettings): Promise<{ ok: boolean; error?: string }> {
  const transport = transportFor(settings);
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    transport.close();
  }
}

/* ------------------------------------------------------------------ bodies */

function layout(heading: string, body: string, action?: { label: string; url: string }): string {
  /* Inline styles and a table-free layout: every interesting email client
     strips <style> blocks, and half of them mangle flexbox. */
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0d1420">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e8ee;border-radius:12px;padding:28px">
    <div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;color:#0b8c7a;margin-bottom:18px">Maestro</div>
    <h1 style="margin:0 0 12px;font-size:19px;line-height:1.3;font-weight:600">${heading}</h1>
    <div style="font-size:14px;line-height:1.6;color:#414c5c">${body}</div>
    ${
      action
        ? `<div style="margin-top:22px"><a href="${action.url}" style="display:inline-block;background:#076253;color:#ffffff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 18px;border-radius:8px">${action.label}</a></div>
    <div style="margin-top:16px;font-size:12px;line-height:1.5;color:#6b7686">If the button does not work, paste this into your browser:<br><span style="word-break:break-all">${action.url}</span></div>`
        : ""
    }
  </div>
</body></html>`;
}

export function passwordResetMessage(to: string, url: string, ttlMinutes: number): Message {
  return {
    to,
    subject: "Reset your Maestro password",
    text: [
      "Someone asked to reset the password for this Maestro account.",
      "",
      `Open this link to choose a new one. It works once and expires in ${ttlMinutes} minutes:`,
      url,
      "",
      "If this was not you, you can ignore this email — your password has not changed.",
    ].join("\n"),
    html: layout(
      "Reset your password",
      `<p style="margin:0 0 10px">Someone asked to reset the password for this Maestro account.</p>
       <p style="margin:0">The link below works once and expires in ${ttlMinutes} minutes. If this was not you, ignore this email — your password has not changed.</p>`,
      { label: "Choose a new password", url },
    ),
  };
}

export function invitationMessage(
  to: string,
  orgName: string,
  role: string,
  url: string,
): Message {
  return {
    to,
    subject: `You have been invited to ${orgName} on Maestro`,
    text: [
      `You have been invited to join ${orgName} on Maestro as a ${role}.`,
      "",
      "Open this link to accept:",
      url,
      "",
      "The invitation works once and expires in seven days.",
    ].join("\n"),
    html: layout(
      `Join ${orgName}`,
      `<p style="margin:0 0 10px">You have been invited to join <strong>${orgName}</strong> on Maestro as a ${role}.</p>
       <p style="margin:0">This invitation works once and expires in seven days.</p>`,
      { label: "Accept invitation", url },
    ),
  };
}

export function testMessage(to: string): Message {
  return {
    to,
    subject: "Maestro SMTP test",
    text: `This is a test from ${config.publicUrl}. If you are reading it, sending works.`,
    html: layout(
      "SMTP is working",
      `<p style="margin:0">This is a test from ${config.publicUrl}. If you are reading it, sending works.</p>`,
    ),
  };
}
