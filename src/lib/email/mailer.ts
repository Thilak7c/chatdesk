// ============================================================
// Outbound email over plain SMTP (any provider: Postmark, SES,
// Mailgun, Gmail, a local Mailpit, ...).
//
// Configure with SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD /
// SMTP_FROM (and optionally SMTP_SECURE=true for implicit TLS on 465).
// When SMTP_HOST is unset, mail is logged to the server console
// instead of sent — enough for local development, and a password
// reset link can be copied from the log.
// ============================================================

import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE
        ? process.env.SMTP_SECURE === 'true'
        : port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' }
        : undefined,
    });
  }
  return transporter;
}

export async function sendMail(message: MailMessage): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.info(
      `[mailer] SMTP_HOST not set — not sending. To: ${message.to}\n` +
        `Subject: ${message.subject}\n\n${message.text}`,
    );
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}
