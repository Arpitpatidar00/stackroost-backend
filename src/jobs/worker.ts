import { setTimeout as sleep } from 'node:timers/promises';
import { loadEnv } from '@/config/env';
import { buildContainer, createInfrastructure } from '@/container';
import { purgeRateLimitBuckets } from '@/middleware/rateLimit.store';
import { OutboxWorker } from './outbox.worker';
import { Scheduler } from './scheduler';

/** Separate process from the API: background work never touches request latency. */
const env = loadEnv();
const infra = createInfrastructure(env);
const { services } = buildContainer(env, infra);
const outbox = new OutboxWorker(infra.uow, infra.mailer, infra.clock, infra.log);
const prisma = infra.prisma;

const scheduler = new Scheduler(
  [
    { name: 'outbox', everyMs: 2_000, run: async () => (await outbox.runOnce()) || null },
    {
      name: 'scheduled-downgrades',
      everyMs: 5 * 60_000,
      run: async () => (await services.subscriptions.applyDueDowngrades()) || null,
    },
    {
      name: 'purge-sessions',
      everyMs: 60 * 60_000,
      run: async () => (await services.auth.purgeExpiredSessions()) || null,
    },
    ...(prisma
      ? [
          {
            name: 'purge-rate-limits',
            everyMs: 10 * 60_000,
            run: async () => (await purgeRateLimitBuckets(prisma)) || null,
          },
        ]
      : []),
  ],
  infra.log,
);

const shutdown = new AbortController();
process.on('SIGTERM', () => {
  shutdown.abort();
});
process.on('SIGINT', () => {
  shutdown.abort();
});

infra.log.info('worker started');
while (!shutdown.signal.aborted) {
  await scheduler.tick();
  await sleep(1_000, undefined, { signal: shutdown.signal }).catch(() => undefined);
}
await infra.close();
infra.log.info('worker stopped');
