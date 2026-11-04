import { describe, expect, it } from 'vitest';
import { isEntitling, resolvePlan, type CatalogPlan, type SubscriptionFacts } from './entitlements';

const plan = (key: string, rank: number): CatalogPlan => ({
  id: `plan_${key}`,
  key,
  name: key,
  rank,
  modules: [key],
  features: [],
});
const basic = plan('basic', 1);
const pro = plan('pro', 2);
const max = plan('max', 3);
const prices: Record<string, CatalogPlan> = { pri_basic: basic, pri_pro: pro, pri_max: max };
const lookup = (id: string) => prices[id] ?? null;
const policy = { pastDueGraceDays: 7 };
const now = new Date('2026-11-02T00:00:00Z');
const sub = (over: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
  status: 'active',
  priceId: 'pri_pro',
  currentPeriodEndsAt: new Date('2026-11-20T00:00:00Z'),
  ...over,
});

describe('isEntitling', () => {
  it.each(['active', 'trialing'] as const)('%s entitles', (status) => {
    expect(isEntitling(sub({ status }), policy, now)).toBe(true);
  });
  it.each(['paused', 'canceled'] as const)('%s does not', (status) => {
    expect(isEntitling(sub({ status }), policy, now)).toBe(false);
  });
  it('past_due entitles inside the grace window only', () => {
    const endedAt = new Date('2026-10-30T00:00:00Z');
    expect(
      isEntitling(sub({ status: 'past_due', currentPeriodEndsAt: endedAt }), policy, now),
    ).toBe(true);
    expect(
      isEntitling(
        sub({ status: 'past_due', currentPeriodEndsAt: endedAt }),
        policy,
        new Date('2026-11-07T00:00:01Z'),
      ),
    ).toBe(false);
    expect(isEntitling(sub({ status: 'past_due', currentPeriodEndsAt: null }), policy, now)).toBe(
      false,
    );
  });
});

describe('resolvePlan', () => {
  it('no subscription → nothing unlocked (no free tier)', () => {
    expect(resolvePlan([], lookup, policy, now)).toBeNull();
  });

  it('an unknown price grants nothing', () => {
    expect(resolvePlan([sub({ priceId: 'pri_other' })], lookup, policy, now)).toBeNull();
  });

  it('picks the highest-ranked entitling plan', () => {
    const subs = [
      sub({ priceId: 'pri_basic' }),
      sub({ priceId: 'pri_max', status: 'canceled' }),
      sub(),
    ];
    expect(resolvePlan(subs, lookup, policy, now)).toBe(pro);
  });

  it('after a downgrade, keeps the previous plan until the grace ends', () => {
    const downgraded = sub({
      priceId: 'pri_pro',
      graceFromPriceId: 'pri_max',
      graceUntil: new Date('2026-11-20T00:00:00Z'),
    });
    expect(resolvePlan([downgraded], lookup, policy, now)).toBe(max);
    expect(resolvePlan([downgraded], lookup, policy, new Date('2026-11-20T00:00:00Z'))).toBe(pro);
  });

  it('grace never resurrects a canceled subscription', () => {
    const canceled = sub({
      status: 'canceled',
      graceFromPriceId: 'pri_max',
      graceUntil: new Date('2026-11-20T00:00:00Z'),
    });
    expect(resolvePlan([canceled], lookup, policy, now)).toBeNull();
  });
});
