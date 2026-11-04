import type { UnitOfWork } from '@/db/unitOfWork';
import type { Mailer } from '@/integrations/mailer/mailer';
import { renderEmail } from '@/integrations/mailer/templates';
import type { Clock } from '@/shared/clock';
import type { Logger } from '@/shared/logger';
import type { OutboxMessage } from './outbox.messages';

const MAX_ATTEMPTS = 8;
/** 30s, 1m, 2m, 4m … capped at 1h. */
const backoff = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 3_600_000);

/**
 * Delivers committed outbox jobs. At-least-once: a crash between send and
 * markDone may resend — acceptable for these emails, never lost.
 */
export class OutboxWorker {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /** One batch; returns how many jobs it handled. */
  async runOnce(batchSize = 20): Promise<number> {
    const now = this.clock.now();
    const jobs = await this.uow.repos.outbox.claimDue(batchSize, now);
    for (const job of jobs) {
      try {
        await this.mailer.send(
          renderEmail({ type: job.type, payload: job.payload } as OutboxMessage),
        );
        await this.uow.repos.outbox.markDone(job.id);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const retryAt =
          job.attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + backoff(job.attempts));
        await this.uow.repos.outbox.markFailed(job.id, error, retryAt);
        this.log.warn(
          { jobId: job.id, type: job.type, attempts: job.attempts, error },
          'outbox job failed',
        );
      }
    }
    return jobs.length;
  }
}
