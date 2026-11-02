import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from './env.js';
import * as schema from '@/database/schema/index.js';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
export const db = drizzle(pool, { schema });

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
// Repositories take one of these so the same query runs standalone or inside a service transaction.
export type DbExecutor = typeof db | DbTransaction;

export const withTransaction = <T>(work: (tx: DbTransaction) => Promise<T>) => db.transaction(work);
