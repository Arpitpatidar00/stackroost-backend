import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import type { PrismaClient } from '@/generated/prisma/client';

/**
 * Postgres-backed fixed-window store for express-rate-limit: limits hold
 * across every API instance (an in-memory store would multiply them).
 * One atomic upsert per hit; expired windows reset in the same statement.
 *
 * Times are bound from the app, never SQL `now()`: Prisma stores UTC in
 * `timestamp without time zone`, so comparing to `now()` would shift by the
 * database's time zone and silently disable the limiter.
 */
export class PostgresRateLimitStore implements Store {
  private windowMs = 60_000;
  readonly localKeys = false;

  constructor(
    private readonly db: PrismaClient,
    readonly prefix: string,
  ) {}

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = new Date();
    const resetAt = new Date(now.getTime() + this.windowMs);
    const [row] = await this.db.$queryRaw<{ hits: number; resetAt: Date }[]>`
      INSERT INTO "rate_limit_buckets" ("key", "hits", "resetAt")
      VALUES (${this.prefix + key}, 1, ${resetAt})
      ON CONFLICT ("key") DO UPDATE SET
        "hits"    = CASE WHEN "rate_limit_buckets"."resetAt" <= ${now} THEN 1 ELSE "rate_limit_buckets"."hits" + 1 END,
        "resetAt" = CASE WHEN "rate_limit_buckets"."resetAt" <= ${now} THEN ${resetAt} ELSE "rate_limit_buckets"."resetAt" END
      RETURNING "hits", "resetAt"`;
    if (!row) throw new Error('rate limit upsert returned nothing');
    return { totalHits: row.hits, resetTime: row.resetAt };
  }

  async decrement(key: string) {
    await this.db.$executeRaw`
      UPDATE "rate_limit_buckets" SET "hits" = GREATEST("hits" - 1, 0) WHERE "key" = ${this.prefix + key}`;
  }

  async resetKey(key: string) {
    await this.db.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" = ${this.prefix + key}`;
  }
}

/** Housekeeping (worker): drop finished windows. */
export async function purgeRateLimitBuckets(db: PrismaClient, now = new Date()): Promise<number> {
  return db.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "resetAt" <= ${now}`;
}
