import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, events, PRICES } from '../../../test/fakes/harness';

let h: ReturnType<typeof createHarness>;
let accountId: string;
const SUB = 'sub_test0001';

beforeEach(async () => {
  h = createHarness();
  await h.seedCatalog();
  accountId = (await h.uow.repos.accounts.upsertByEmail('pro@example.com')).id;
  await h.subscribe(accountId); // Pro monthly, period ends 2026-12-02
});
const plan = async () => (await h.billing.summary(h.uow.repos, accountId)).plan?.key;

describe('upgrade (Pro → Max)', () => {
  it('previews the prorated amount due now', async () => {
    const p = await h.subscriptions.preview(accountId, PRICES.maxMonthly);
    expect(p).toMatchObject({
      change: 'upgrade',
      effectiveAt: 'now',
      dueNow: { action: 'charge', amount: '1000' },
    });
    expect(h.gateway.callsTo('previewPriceChange')).toEqual([[SUB, PRICES.maxMonthly, true]]);
  });

  it('charges the prorated difference immediately and applies on the webhook', async () => {
    const res = await h.subscriptions.change(accountId, PRICES.maxMonthly);
    expect(res).toEqual({ change: 'upgrade', effectiveAt: 'now', plan: 'max' });
    expect(h.gateway.callsTo('changePrice')).toEqual([[SUB, PRICES.maxMonthly, true]]);
    await h.deliver(events.subscription({ priceId: PRICES.maxMonthly }, '2026-11-02T13:00:00Z'));
    expect(await plan()).toBe('max');
  });

  it('monthly → yearly on the same plan is an immediate prorated switch', async () => {
    expect((await h.subscriptions.change(accountId, PRICES.proYearly)).change).toBe(
      'interval_switch',
    );
    expect(h.gateway.callsTo('changePrice')).toEqual([[SUB, PRICES.proYearly, true]]);
  });

  it('a failing Paddle call changes nothing', async () => {
    h.gateway.failNext.add('changePrice');
    await expect(h.subscriptions.change(accountId, PRICES.maxMonthly)).rejects.toThrow();
    expect(await plan()).toBe('pro');
  });
});

describe('downgrade (Pro → Basic)', () => {
  it('is scheduled for the period end; nothing is billed or changed now', async () => {
    const res = await h.subscriptions.change(accountId, PRICES.basicMonthly);
    expect(res).toEqual({
      change: 'downgrade',
      effectiveAt: '2026-12-02T00:00:00.000Z',
      plan: 'basic',
    });
    expect(h.gateway.callsTo('changePrice')).toHaveLength(0);
    expect(await plan()).toBe('pro');
  });

  it('the worker applies it just before renewal without billing; Pro stays until the period ends', async () => {
    await h.subscriptions.change(accountId, PRICES.basicMonthly);
    expect(await h.subscriptions.applyDueDowngrades()).toBe(0); // weeks away

    h.clock.current = new Date('2026-12-01T23:30:00Z'); // inside the 60-min lead
    expect(await h.subscriptions.applyDueDowngrades()).toBe(1);
    expect(h.gateway.callsTo('changePrice')).toEqual([[SUB, PRICES.basicMonthly, false]]);

    // Paddle confirms the new price; access stays Pro until the paid period ends.
    await h.deliver(events.subscription({ priceId: PRICES.basicMonthly }, '2026-12-01T23:31:00Z'));
    expect(await plan()).toBe('pro');
    h.clock.current = new Date('2026-12-02T00:00:01Z');
    expect(await plan()).toBe('basic');
  });

  it('a failed apply is retried on the next run', async () => {
    await h.subscriptions.change(accountId, PRICES.basicMonthly);
    h.clock.current = new Date('2026-12-01T23:30:00Z');
    h.gateway.failNext.add('changePrice');
    expect(await h.subscriptions.applyDueDowngrades()).toBe(0);
    expect(await h.subscriptions.applyDueDowngrades()).toBe(1);
  });

  it('can be cancelled before it applies', async () => {
    await h.subscriptions.change(accountId, PRICES.basicMonthly);
    await h.subscriptions.cancelScheduledChange(accountId);
    h.clock.current = new Date('2026-12-01T23:30:00Z');
    expect(await h.subscriptions.applyDueDowngrades()).toBe(0);
  });

  it('an upgrade supersedes a scheduled downgrade', async () => {
    await h.subscriptions.change(accountId, PRICES.basicMonthly);
    await h.subscriptions.change(accountId, PRICES.maxMonthly);
    expect(h.uow.state.subscriptions.get(SUB)?.pendingPriceId).toBeNull();
  });
});

describe('guards', () => {
  it('refuses a change to the current price', async () => {
    await expect(h.subscriptions.change(accountId, PRICES.proMonthly)).rejects.toMatchObject({
      code: 'PLAN_CHANGE_INVALID',
    });
  });

  it('refuses changes while payment is failing', async () => {
    await h.deliver(
      events.subscription(
        { status: 'past_due', currentPeriodEndsAt: new Date('2026-11-01T00:00:00Z') },
        '2026-11-02T13:00:00Z',
      ),
    );
    await expect(h.subscriptions.change(accountId, PRICES.maxMonthly)).rejects.toMatchObject({
      code: 'PLAN_CHANGE_INVALID',
    });
  });

  it('refuses changes while a cancellation is scheduled', async () => {
    await h.deliver(
      events.subscription(
        { scheduledChange: { action: 'cancel', effectiveAt: new Date('2026-12-02T00:00:00Z') } },
        '2026-11-02T13:00:00Z',
      ),
    );
    await expect(h.subscriptions.change(accountId, PRICES.maxMonthly)).rejects.toMatchObject({
      code: 'PLAN_CHANGE_INVALID',
    });
  });

  it('needs an active subscription', async () => {
    const other = await h.uow.repos.accounts.upsertByEmail('nosub@example.com');
    await expect(h.subscriptions.change(other.id, PRICES.maxMonthly)).rejects.toMatchObject({
      code: 'NO_SUBSCRIPTION',
    });
  });
});
