import {
  cleanupExpiredSessions,
  processDueAutomationExecutions,
  sweepStaleFlowRuns,
} from './jobs'

const globalForScheduler = globalThis as unknown as { __chatdesk_scheduler?: boolean }

/** Run `job` every `everyMs`, never overlapping with itself. */
function every(name: string, everyMs: number, job: () => Promise<unknown>) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await job()
    } catch (err) {
      console.error(`[scheduler] ${name} failed:`, err)
    } finally {
      running = false
    }
  }
  setInterval(tick, everyMs).unref()
}

/** Start the background job loop once per process. */
export function startScheduler() {
  if (globalForScheduler.__chatdesk_scheduler) return
  globalForScheduler.__chatdesk_scheduler = true

  every('automation waits', 60_000, () => processDueAutomationExecutions())
  every('stale flow runs', 5 * 60_000, () => sweepStaleFlowRuns())
  every('expired sessions', 60 * 60_000, () => cleanupExpiredSessions())
}
