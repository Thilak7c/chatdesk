import { NextResponse } from 'next/server';

import { createSession } from '@/lib/auth/session';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  resetPasswordWithToken,
} from '@/lib/auth/users';

export async function POST(request: Request) {
  let body: { token?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!token) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    );
  }

  const userId = await resetPasswordWithToken(token, password);
  if (!userId) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
  }

  // Every old session was revoked; sign this browser in fresh.
  await createSession(userId);
  return NextResponse.json({ ok: true });
}
