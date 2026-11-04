import type { Logger } from '@/shared/logger';

export interface Job {
  name: string;
  everyMs: number;
  run(): Promise<unknown>;
}

/**
 * Minimal in-process scheduler for the worker: each job runs on its own
 * cadence; a failing job is logged and retried next tick, never crashes the loop.
 */
export class Scheduler {
  private readonly lastRun = new Map<string, number>();

  constructor(
    private readonly jobs: Job[],
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async tick(): Promise<void> {
    for (const job of this.jobs) {
      const last = this.lastRun.get(job.name) ?? 0;
      if (this.now() - last < job.everyMs) continue;
      this.lastRun.set(job.name, this.now());
      try {
        const result = await job.run();
        if (result) this.log.info({ job: job.name, result }, 'job ran');
      } catch (err) {
        this.log.error({ err, job: job.name }, 'job failed');
      }
    }
  }
}
