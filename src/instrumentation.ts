// Runs once when the Next.js server starts. Starts the in-process
// background job loop (Node runtime only), so a self-hosted install
// needs no external cron. Set DISABLE_INTERNAL_CRON=true to turn it
// off — e.g. when running several app replicas and driving the
// /api/*/cron endpoints from one external scheduler instead.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.DISABLE_INTERNAL_CRON !== 'true') {
    const { startScheduler } = await import('./lib/cron/scheduler')
    startScheduler()
  }
}
