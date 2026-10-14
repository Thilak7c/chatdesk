import { NextResponse } from 'next/server';

import { createPasswordResetToken, normalizeEmail } from '@/lib/auth/users';
import { sendMail } from '@/lib/email/mailer';
import { siteUrlFrom } from '@/lib/site-url';
import {
  checkRateLimit,
  clientIp,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(request: Request) {
  let body: { email?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  if (!email) {
    return NextResponse.json({ error: 'Missing email' }, { status: 400 });
  }

  for (const key of [`reset:ip:${clientIp(request)}`, `reset:email:${email}`]) {
    const limit = checkRateLimit(key, RATE_LIMITS.passwordReset);
    if (!limit.success) return rateLimitResponse(limit);
  }

  // Same response whether or not the email is registered, so this
  // endpoint can't be used to discover accounts.
  try {
    // Resolved before the user lookup so a misconfiguration fails the
    // same way for every email.
    const baseUrl = siteUrlFrom(request, { strict: true });
    const issued = await createPasswordResetToken(email);
    if (issued) {
      const link = `${baseUrl}/reset-password?token=${encodeURIComponent(issued.token)}`;
      await sendMail({
        to: issued.email,
        subject: 'Reset your password',
        text:
          `Someone (hopefully you) asked to reset the password for ${issued.email}.\n\n` +
          `Open this link within one hour to choose a new password:\n${link}\n\n` +
          `If you didn't ask for this, you can ignore this email — your password won't change.`,
      });
    }
  } catch (err) {
    console.error('[forgot-password] failed:', err);
    return NextResponse.json({ error: 'Could not send reset email' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
