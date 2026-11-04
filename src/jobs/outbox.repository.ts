import type { OutboxJob } from '@/generated/prisma/client';
import type { DbClient } from '@/db/prisma';
import type { OutboxMessage } from './outbox.messages';

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
  /** Claims due jobs with SKIP LOCKED so several workers never double-send. */
  claimDue(limit: number, now: Date): Promise<OutboxJob[]>;
  markDone(id: string): Promise<void>;
  markFailed(id: string, error: string, retryAt: Date | null): Promise<void>;
}

export class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly db: DbClient) {}

  async enqueue(message: OutboxMessage) {
    await this.db.outboxJob.create({ data: { type: message.type, payload: message.payload } });
  }

  claimDue(limit: number, now: Date) {
    return this.db.$queryRaw<OutboxJob[]>`
      UPDATE "outbox_jobs" SET "attempts" = "attempts" + 1, "updatedAt" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "outbox_jobs"
        WHERE "status" = 'pending' AND "runAfter" <= ${now}
        ORDER BY "runAfter" LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
  }

  async markDone(id: string) {
    await this.db.outboxJob.update({ where: { id }, data: { status: 'done', lastError: null } });
  }

  async markFailed(id: string, error: string, retryAt: Date | null) {
    await this.db.outboxJob.update({
      where: { id },
      data: retryAt
        ? { lastError: error, runAfter: retryAt }
        : { lastError: error, status: 'failed' },
    });
  }
}
