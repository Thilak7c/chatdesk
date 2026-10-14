import { NextResponse } from 'next/server';

import { createSession } from '@/lib/auth/session';
import {
  createUserWithPersonalAccount,
  EmailTakenError,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from '@/lib/auth/users';
import {
  checkRateLimit,
  clientIp,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const limit = checkRateLimit(`signup:${clientIp(request)}`, RATE_LIMITS.signup);
  if (!limit.success) return rateLimitResponse(limit);

  let body: { fullName?: unknown; email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const fullName = typeof body.fullName === 'string' ? body.fullName.slice(0, 120) : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    );
  }

  try {
    const { userId } = await createUserWithPersonalAccount({ email, password, fullName });
    // No email verification step — the new user is signed straight in.
    await createSession(userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof EmailTakenError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error('[signup] error:', err);
    return NextResponse.json({ error: 'Could not create account' }, { status: 500 });
  }
}
