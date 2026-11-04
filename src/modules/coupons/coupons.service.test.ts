import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, PRICES } from '../../../test/fakes/harness';
import type { CouponInput } from './coupons.service';

let h: ReturnType<typeof createHarness>;
let plans: Awaited<ReturnType<ReturnType<typeof createHarness>['seedCatalog']>>;
const actor = { accountId: 'admin_1', ip: null };
const input = (over: Partial<CouponInput> = {}): CouponInput => ({
  code: 'welcome20',
  description: 'Welcome',
  type: 'percentage',
  amount: 20,
  currency: null,
  recurring: true,
  maxRecurringIntervals: 3,
  usageLimit: 500,
  expiresAt: new Date('2027-01-01T00:00:00Z'),
  planIds: [],
  ...over,
});

beforeEach(async () => {
  h = createHarness();
  plans = await h.seedCatalog();
});

describe('admin coupons', () => {
  it('creates a Paddle discount with the same rules, restricted to the chosen plans’ prices', async () => {
    const c = await h.coupons.create(actor, input({ planIds: [plans.pro.id] }));
    expect(c).toMatchObject({ code: 'WELCOME20', isActive: true, createdById: 'admin_1' });
    expect(h.gateway.callsTo('createDiscount')).toEqual([
      [
        expect.objectContaining({
          code: 'WELCOME20',
          type: 'percentage',
          amount: '20',
          recurring: true,
          maxRecurringIntervals: 3,
          usageLimit: 500,
          restrictToPriceIds: [PRICES.proMonthly, PRICES.proYearly],
        }),
      ],
    ]);
    expect(h.uow.state.audit.at(-1)).toMatchObject({ action: 'coupon.create' });
  });

  it.each([
    [{ amount: 0 }, 'amount'],
    [{ amount: 101 }, 'amount'],
    [{ type: 'flat' as const, amount: 500, currency: null }, 'currency'],
    [{ code: 'a b' }, 'code'],
  ])('validates %o (%s)', async (over, _field) => {
    await expect(h.coupons.create(actor, input(over))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(h.gateway.callsTo('createDiscount')).toHaveLength(0);
  });

  it('refuses a duplicate code (case-insensitive)', async () => {
    await h.coupons.create(actor, input());
    await expect(h.coupons.create(actor, input({ code: 'WELCOME20' }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('deactivating disables it in Paddle and blocks new checkouts', async () => {
    const c = await h.coupons.create(actor, input());
    await h.coupons.setActive(actor, c.id, false);
    expect(h.gateway.callsTo('setDiscountActive')).toEqual([[c.paddleDiscountId, false]]);
    await expect(h.coupons.resolve('welcome20', plans.pro.id)).rejects.toMatchObject({
      code: 'COUPON_INVALID',
    });
  });
});
