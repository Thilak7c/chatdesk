import { NextResponse } from 'next/server'

import { checkCronSecret } from '@/lib/cron/auth'
import { sweepStaleFlowRuns } from '@/lib/cron/jobs'

/**
 * Sweep abandoned active flow runs past their flow's
 * `fallback_policy.on_timeout_hours` (default 24h) to `timed_out`.
 * The app already runs this periodically in-process (see
 * src/instrumentation.ts); this endpoint is for external schedulers.
 * Requires `x-cron-secret: $AUTOMATION_CRON_SECRET`.
 */
export async function GET(request: Request) {
  const denied = checkCronSecret(request)
  if (denied) return denied

  try {
    return NextResponse.json({ swept: await sweepStaleFlowRuns() })
  } catch (err) {
    console.error('[flows-cron] failed:', err)
    return NextResponse.json({ error: 'cron run failed' }, { status: 500 })
  }
}
