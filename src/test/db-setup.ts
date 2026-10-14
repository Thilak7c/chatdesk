// Per-file setup for the `db` test project. Points the app's `db`
// client at the test database (before any module imports it) and
// empties every table before each test.

import { afterAll, beforeEach } from 'vitest'

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
}

beforeEach(async () => {
  if (!process.env.TEST_DATABASE_URL) return
  const { db } = await import('@/db')
  const { sql } = await import('drizzle-orm')
  const result = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  )
  const names = result.rows.map((r) => `"${r.tablename}"`).join(', ')
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`))
})

afterAll(async () => {
  // Let the process exit: close the shared pool this file opened.
  const g = globalThis as unknown as { __chatdesk_pool?: { end(): Promise<void> } }
  await g.__chatdesk_pool?.end().catch(() => {})
  delete (globalThis as Record<string, unknown>).__chatdesk_pool
})
