// Runs once before the `db` test project: rebuilds the test database
// from the Drizzle migrations so every run starts from the real schema.
//
// DESTRUCTIVE — drops everything in TEST_DATABASE_URL. Point it at a
// throwaway database, never at one holding data you care about.

import path from 'node:path'
import { Client } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    console.warn('[db tests] TEST_DATABASE_URL not set — database suites will be skipped.')
    return
  }

  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('drop schema if exists public cascade')
    await client.query('drop schema if exists drizzle cascade')
    await client.query('create schema public')
    await migrate(drizzle(client), {
      migrationsFolder: path.resolve(__dirname, '../../drizzle'),
    })
  } finally {
    await client.end()
  }
}
