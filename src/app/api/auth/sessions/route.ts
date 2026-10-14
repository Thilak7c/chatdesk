import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { destroyAllSessionsForUser, destroyCurrentSession } from '@/lib/auth/session';

/** Sign out everywhere — every device, including this one. */
export async function DELETE() {
  try {
    const ctx = await getCurrentAccount();
    await destroyAllSessionsForUser(ctx.userId);
    await destroyCurrentSession();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
