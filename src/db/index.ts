import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** A transaction handle — same query API as `db`. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything you can run a query on: the root db or a transaction. */
export type DbOrTx = Database | Tx;

// One pool per process. In dev, Next re-evaluates modules on every
// edit, so the pool is parked on globalThis to avoid leaking a new
// set of connections per hot reload.
const globalForDb = globalThis as unknown as { __chatdesk_pool?: Pool };

const pool =
  globalForDb.__chatdesk_pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });

if (process.env.NODE_ENV !== 'production') globalForDb.__chatdesk_pool = pool;

export const db: Database = drizzle(pool, { schema });
