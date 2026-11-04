import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, events, PRICES } from '../../../test/fakes/harness';

let h: ReturnType<typeof createHarness>;
beforeEach(async () => {
  h = createHarness();
  await h.seedCatalog();
});

describe('webhooks', () => {
  it('rejects a bad signature (non-2xx → Paddle retries)', async () => {
    await expect(h.billing.handleWebhook('{}', 'forged')).rejects.toMatchObject({
      code: 'WEBHOOK_REJECTED',
      status: 401,
    });
  });

  it('signed checkout link → subscription lands on that account, license issued once', async () => {
    const buyer = await h.uow.repos.accounts.upsertByEmail('buyer@example.com');
    expect(await h.subscribe(buyer.id)).toBe('processed');
    expect(h.uow.state.customers.get('ctm_1')?.accountId).toBe(buyer.id);
    expect(h.uow.outboxOf('email.license_issued')).toEqual([
      expect.objectContaining({ email: 'buyer@example.com' }),
    ]);
  });

  it('ignores a forged (unsigned) account link', async () => {
    const victim = await h.uow.repos.accounts.upsertByEmail('victim@example.com');
    await h.deliver(events.subscription({ accountId: victim.id, accountSig: 'forged' }));
    expect(h.uow.state.customers.get('ctm_1')?.accountId).toBeNull();
    expect(h.uow.state.licenses.size).toBe(0);
  });

  it('falls back to the customer email when there is no link (e.g. dashboard-created subscription)', async () => {
    await h.deliver(events.subscription({}, '2026-11-02T10:00:01Z', 'subscription.created'));
    await h.deliver(events.customer('ctm_1', 'Late@Example.com', '2026-11-02T10:00:00Z'));
    expect(h.uow.outboxOf('email.license_issued')).toEqual([
      expect.objectContaining({ email: 'late@example.com' }),
    ]);
  });

  it('keeps a checkout-bound customer on its account even if the Paddle email differs', async () => {
    const buyer = await h.uow.repos.accounts.upsertByEmail('buyer@example.com');
    await h.subscribe(buyer.id);
    await h.deliver(events.customer('ctm_1', 'other-email@example.com'));
    expect(h.uow.state.customers.get('ctm_1')).toMatchObject({
      accountId: buyer.id,
      email: 'other-email@example.com',
    });
  });

  it('is idempotent and convergent', async () => {
    const buyer = await h.uow.repos.accounts.upsertByEmail('buyer@example.com');
    const e = events.subscription({}, '2026-11-03T00:00:00Z');
    await h.subscribe(buyer.id);
    expect(await h.deliver(e)).toBe('processed');
    expect(await h.deliver(e)).toBe('duplicate');
    await h.deliver(events.subscription({ status: 'canceled' }, '2026-11-04T00:00:00Z'));
    await h.deliver(events.subscription({ status: 'active' }, '2026-11-02T00:00:00Z')); // stale retry
    expect(h.uow.state.subscriptions.get('sub_test0001')?.status).toBe('canceled');
    expect(h.uow.outboxOf('email.license_issued')).toHaveLength(1);
  });

  it('a price that is not in the catalogue unlocks nothing', async () => {
    const buyer = await h.uow.repos.accounts.upsertByEmail('buyer@example.com');
    await h.subscribe(buyer.id, { priceId: 'pri_01notours00000' });
    expect(h.uow.state.licenses.size).toBe(0);
  });
});

describe('summary', () => {
  it('shows the plan, its modules and a scheduled downgrade', async () => {
    const buyer = await h.uow.repos.accounts.upsertByEmail('buyer@example.com');
    await h.subscribe(buyer.id, { priceId: PRICES.maxMonthly });
    await h.uow.repos.subscriptions.setPending('sub_test0001', PRICES.basicMonthly, h.clock.now());
    const s = await h.billing.summary(h.uow.repos, buyer.id);
    expect(s.plan).toMatchObject({ key: 'max', modules: expect.arrayContaining(['kafka']) });
    expect(s.subscription?.pendingPlanChange).toEqual({
      plan: 'basic',
      priceId: PRICES.basicMonthly,
      effectiveAt: '2026-12-02T00:00:00.000Z',
    });
  });

  it('no subscription → no plan (everything locked)', async () => {
    const a = await h.uow.repos.accounts.upsertByEmail('new@example.com');
    expect((await h.billing.summary(h.uow.repos, a.id)).plan).toBeNull();
  });
});
