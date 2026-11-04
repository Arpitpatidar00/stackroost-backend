import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '@/db/prisma';
import { PrismaUnitOfWork } from '@/db/unitOfWork';
import { PostgresRateLimitStore } from '@/middleware/rateLimit.store';
import { ADMIN_EMAIL, createHarness, events, PRICES, WEBSITE } from '../fakes/harness';

/**
 * The same flows as the unit suite, on real Postgres: proves the Prisma
 * repositories, raw SQL (row lock, rate-limit upsert), groupBy stats and
 * case-insensitive search behave like the in-memory fakes.
 */
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('Set DATABASE_URL_TEST to a migrated, disposable database.');
const prisma = createPrisma(url);

const TABLES = [
  'audit_logs',
  'rate_limit_buckets',
  'outbox_jobs',
  'webhook_events',
  'activations',
  'licenses',
  'sessions',
  'subscriptions',
  'customers',
  'coupons',
  'plan_prices',
  'plans',
  'accounts',
];
let h: ReturnType<typeof createHarness>;

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  h = createHarness({ uow: new PrismaUnitOfWork(prisma) });
  await h.seedCatalog();
});
afterAll(() => prisma.$disconnect());

const fromSite = (cookie: string) => ({ Cookie: cookie, Origin: WEBSITE });
const keyFromOutbox = async () => {
  const job = await prisma.outboxJob.findFirstOrThrow({ where: { type: 'email.license_issued' } });
  return (job.payload as { licenseKey: string }).licenseKey;
};

describe('on Postgres', () => {
  it('register → checkout → subscribe → activate (device limit under row lock) → upgrade', async () => {
    const { cookie, account } = await h.signIn('buyer@example.com');
    await request(h.app)
      .post('/v1/billing/checkout')
      .set(fromSite(cookie))
      .send({ priceId: PRICES.proMonthly })
      .expect(201);
    expect(await prisma.customer.findFirst({ where: { accountId: account.id } })).not.toBeNull();

    expect(await h.subscribe(account.id)).toBe('processed');
    expect(await h.subscribe(account.id)).toBe('processed'); // new event id, same state: no second license
    expect(await prisma.license.count()).toBe(1);

    const key = await keyFromOutbox();
    const device = (n: number) => ({
      licenseKey: key,
      deviceId: `device-00000000000${String(n)}`,
      deviceName: `Mac ${String(n)}`,
      appVersion: '0.2.0',
    });
    // Concurrent activations of 3 Macs on a 2-seat license: the row lock admits exactly 2.
    const results = await Promise.all(
      [1, 2, 3].map((n) => request(h.app).post('/v1/licenses/activate').send(device(n))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 409]);
    expect(await prisma.activation.count()).toBe(2);

    await request(h.app)
      .post('/v1/billing/subscription/change')
      .set(fromSite(cookie))
      .send({ priceId: PRICES.maxMonthly })
      .expect(200);
    await h.deliver(events.subscription({ priceId: PRICES.maxMonthly }, '2026-11-02T13:00:00Z'));
    const after = await request(h.app).get('/v1/account').set('Cookie', cookie).expect(200);
    expect(after.body.data.plan.key).toBe('max');
  });

  it('scheduled downgrade: applied before renewal, previous plan kept until period end', async () => {
    const real = h.container.infra.uow;
    const acct = await real.repos.accounts.upsertByEmail('pro@example.com');
    await h.subscribe(acct.id);
    await h.subscriptions.change(acct.id, PRICES.basicMonthly);
    h.clock.current = new Date('2026-12-01T23:30:00Z');
    expect(await h.subscriptions.applyDueDowngrades()).toBe(1);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: 'sub_test0001' } });
    expect(row).toMatchObject({ pendingPriceId: null, graceFromPriceId: PRICES.proMonthly });
    // A later webhook must not wipe the grace fields.
    await h.deliver(events.subscription({ priceId: PRICES.basicMonthly }, '2026-12-01T23:31:00Z'));
    expect((await h.billing.summary(real.repos, acct.id)).plan?.key).toBe('pro');
  });

  it('admin: search, stats (groupBy) and audit on real tables', async () => {
    const buyer = await h.container.infra.uow.repos.accounts.upsertByEmail('buyer@example.com');
    await h.subscribe(buyer.id);
    const { cookie } = await h.signIn(ADMIN_EMAIL);
    const subs = await request(h.app)
      .get('/v1/admin/subscriptions')
      .query({ search: 'BUYER' })
      .set('Cookie', cookie)
      .expect(200);
    expect(subs.body.data).toHaveLength(1);
    const stats = await request(h.app).get('/v1/admin/stats').set('Cookie', cookie).expect(200);
    expect(stats.body.data).toMatchObject({
      subscriptionsByPlan: { pro: { active: 1 } },
      mrrMinor: { USD: 1500 },
    });
    await request(h.app)
      .post('/v1/admin/coupons')
      .set(fromSite(cookie))
      .send({ code: 'SPRING', description: 'Spring', type: 'flat', amount: 500, currency: 'USD' })
      .expect(201);
    expect(await prisma.auditLog.count({ where: { action: 'coupon.create' } })).toBe(1);
  });

  it('rate-limit store counts atomically across concurrent hits and resets', async () => {
    const store = new PostgresRateLimitStore(prisma, 't:');
    store.init({ windowMs: 60_000 } as never);
    const hits = await Promise.all(Array.from({ length: 10 }, () => store.increment('ip')));
    expect(hits.map((x) => x.totalHits).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    await store.resetKey('ip');
    expect((await store.increment('ip')).totalHits).toBe(1);
  });

  it('no raw SQL depends on the database time zone', async () => {
    // Regression: comparing app-written UTC timestamps to now() broke under a non-UTC DB zone.
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'Asia/Kolkata'`);
    const store = new PostgresRateLimitStore(prisma, 'tz:');
    store.init({ windowMs: 60_000 } as never);
    await store.increment('ip');
    expect((await store.increment('ip')).totalHits).toBe(2);
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`);
  });

  it('each request is counted once against the general budget', async () => {
    const limited = createHarness({
      uow: new PrismaUnitOfWork(prisma),
      rateLimitStore: (prefix) => new PostgresRateLimitStore(prisma, prefix),
    });
    await request(limited.app).get('/v1/plans').expect(200);
    const general = await prisma.rateLimitBucket.findMany({
      where: { key: { startsWith: 'general:' } },
    });
    expect(general.map((b) => b.hits)).toEqual([1]);
  });

  it('sessions: purge removes idle/expired ones', async () => {
    await h.signIn('a@example.com');
    h.clock.advanceDays(40);
    expect(await h.auth.purgeExpiredSessions()).toBe(1);
  });
});
