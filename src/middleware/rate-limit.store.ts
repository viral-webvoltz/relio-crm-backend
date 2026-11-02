import { sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import type { CounterHit, CounterStore } from './auth-limiter.js';

// One statement, one round trip: bump every key's counter for the current window and read the new counts back.
// The window is aligned to the DATABASE clock, so all API instances agree on where a window starts and ends, whatever their own clocks say.
// Keys are always locked in the order given (user, then organization), so concurrent requests cannot deadlock each other.
export const postgresCounterStore: CounterStore = {
  async hit(keys, windowSeconds) {
    const width = sql.raw(String(Math.trunc(windowSeconds))); // a validated integer, never client input
    const rows = sql.join(
      keys.map((key) => sql`(${key}, to_timestamp(floor(extract(epoch from now()) / ${width}) * ${width}), 1)`),
      sql`, `,
    );
    const result = await db.execute<{ key: string; count: number; reset: number }>(sql`
      insert into rate_limit_counters (key, window_start, count)
      values ${rows}
      on conflict (key, window_start) do update set count = rate_limit_counters.count + 1
      returning key, count, extract(epoch from (window_start + make_interval(secs => ${width}) - now()))::float8 as reset
    `);
    return result.rows.map((row): CounterHit => ({ key: row.key, count: Number(row.count), resetSeconds: Number(row.reset) }));
  },
};

// Old windows are never read again; this just keeps the table small.
export const purgeRateLimitCounters = () => db.execute(sql`delete from rate_limit_counters where window_start < now() - interval '10 minutes'`);
