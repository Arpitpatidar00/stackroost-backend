import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, PRICES } from '../../../test/fakes/harness';
import { verifyAccountLink } from './checkout.service';

let h: ReturnType<typeof createHarness>;
let plans: Awaited<ReturnType<ReturnType<typeof createHarness>['seedCatalog']>>;
const admin = { accountId: 'admin_1', ip: null };
const buyer = { accountId: '', email: 'buyer@example.com', name: null };

beforeEach(async () => {
  h = createHarness();
  plans = await h.seedCatalog();
  buyer.accountId = (await h.uow.repos.accounts.upsertByEmail(buyer.email)).id;
});

const coupon = (over: Partial<Parameters<typeof h.coupons.create>[1]> = {}) =>
  h.coupons.create(admin, {
    code: 'launch50',
    description: 'Launch',
    type: 'percentage',
    amount: 50,
    currency: null,
    recurring: false,
    maxRecurringIntervals: null,
    usageLimit: 100,
    expiresAt: null,
    planIds: [],
    ...over,
  });

describe('checkout', () => {
  it('creates a server-side Paddle transaction bound to the account (signed)', async () => {
    const res = await h.checkout.start(buyer, { priceId: PRICES.proMonthly });
    expect(res.transactionId).toMatch(/^txn_/);
    const [[input]] = h.gateway.callsTo('createCheckout') as [
      [{ priceId: string; customData: Record<string, string> }],
    ];
    expect(input.priceId).toBe(PRICES.proMonthly);
    expect(
      verifyAccountLink(h.hmac, input.customData.accountId!, input.customData.accountSig!),
    ).toBe(true);
    expect(input.customData.accountId).toBe(buyer.accountId);
  });

  it('reuses the account’s Paddle customer on later checkouts', async () => {
    await h.checkout.start(buyer, { priceId: PRICES.proMonthly });
    await h.checkout.start(buyer, { priceId: PRICES.basicMonthly });
    expect(h.gateway.callsTo('ensureCustomer')).toHaveLength(1);
  });

  it('applies an admin coupon as the Paddle discount', async () => {
    const c = await coupon();
    const res = await h.checkout.start(buyer, {
      priceId: PRICES.proMonthly,
      couponCode: ' Launch50 ',
    });
    expect(res.coupon).toMatchObject({ code: 'LAUNCH50', type: 'percentage', amount: '50' });
    const [[input]] = h.gateway.callsTo('createCheckout') as [[{ discountId: string }]];
    expect(input.discountId).toBe(c.paddleDiscountId);
  });

  it.each([
    ['unknown', async () => undefined, 'NOPE123'],
    [
      'expired',
      async () => {
        await coupon({ expiresAt: new Date('2026-11-03T00:00:00Z') });
        h.clock.advanceDays(2);
      },
      'LAUNCH50',
    ],
    ['other plan', () => coupon({ planIds: [plans.max.id] }), 'LAUNCH50'],
  ])('rejects a %s coupon with one generic error', async (_case, setup, code) => {
    await setup();
    await expect(
      h.checkout.start(buyer, { priceId: PRICES.proMonthly, couponCode: code }),
    ).rejects.toMatchObject({
      code: 'COUPON_INVALID',
      message: 'That coupon code can’t be used for this plan.',
    });
    expect(h.gateway.callsTo('createCheckout')).toHaveLength(0);
  });

  it('refuses unknown or deactivated prices', async () => {
    await expect(h.checkout.start(buyer, { priceId: 'pri_01unknown00000' })).rejects.toMatchObject({
      code: 'PLAN_UNAVAILABLE',
    });
    const price = (await h.uow.repos.catalog.findPriceByPaddleId(PRICES.basicMonthly))!;
    await h.catalog.setPriceActive(admin, price.id, false);
    await expect(h.checkout.start(buyer, { priceId: PRICES.basicMonthly })).rejects.toMatchObject({
      code: 'PLAN_UNAVAILABLE',
    });
  });

  it('refuses a second subscription — existing subscribers change plan instead', async () => {
    await h.subscribe(buyer.accountId);
    await expect(h.checkout.start(buyer, { priceId: PRICES.maxMonthly })).rejects.toMatchObject({
      code: 'ALREADY_SUBSCRIBED',
      status: 409,
    });
  });
});
