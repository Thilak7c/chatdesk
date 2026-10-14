import { NextResponse } from 'next/server'

import { checkCronSecret } from '@/lib/cron/auth'
import { processDueAutomationExecutions } from '@/lib/cron/jobs'

/**
 * Drain due `automation_pending_executions` rows (elapsed `wait`
 * steps). The app already runs this every minute in-process (see
 * src/instrumentation.ts); this endpoint is for external schedulers.
 * Requires `x-cron-secret: $AUTOMATION_CRON_SECRET`.
 */
export async function GET(request: Request) {
  const denied = checkCronSecret(request)
  if (denied) return denied

  try {
    return NextResponse.json({ processed: await processDueAutomationExecutions() })
  } catch (err) {
    console.error('[automations-cron] failed:', err)
    return NextResponse.json({ error: 'cron run failed' }, { status: 500 })
  }
}
