import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

/**
 * Gate for the HTTP cron endpoints: the `x-cron-secret` header must
 * match `AUTOMATION_CRON_SECRET`. Returns an error response, or null
 * when the caller is allowed.
 */
export function checkCronSecret(request: Request): NextResponse | null {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Constant-time compare so the secret can't be recovered from
  // response-time deltas. The length pre-check is required by
  // timingSafeEqual and leaks only the length.
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
