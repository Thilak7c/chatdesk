// Apply pending database migrations from ./drizzle, then exit.
//
//   node scripts/migrate.mjs           (npm run db:migrate)
//
// Idempotent: already-applied migrations are skipped, so it is safe to
// run on every deploy / container start. Reads DATABASE_URL from the
// environment, falling back to .env.local / .env in the project root.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import dotenv from 'dotenv'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const file of ['.env.local', '.env']) {
  const p = path.join(root, file)
  if (existsSync(p)) dotenv.config({ path: p, quiet: true })
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('[migrate] DATABASE_URL is not set')
  process.exit(1)
}

const client = new pg.Client({ connectionString: url })
try {
  await client.connect()
  await migrate(drizzle(client), { migrationsFolder: path.join(root, 'drizzle') })
  console.log('[migrate] database is up to date')
} catch (err) {
  console.error('[migrate] failed:', err)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
