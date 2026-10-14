import { NextResponse } from 'next/server';

import { createSession } from '@/lib/auth/session';
import { normalizeEmail, verifyCredentials } from '@/lib/auth/users';
import {
  checkRateLimit,
  clientIp,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(request: Request) {
  let body: { email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return NextResponse.json({ error: 'Missing email or password' }, { status: 400 });
  }

  for (const key of [`login:ip:${clientIp(request)}`, `login:email:${email}`]) {
    const limit = checkRateLimit(key, RATE_LIMITS.login);
    if (!limit.success) return rateLimitResponse(limit);
  }

  const userId = await verifyCredentials(email, password);
  if (!userId) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  await createSession(userId);
  return NextResponse.json({ ok: true });
}
