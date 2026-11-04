import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../../../test/fakes/harness';

let h: ReturnType<typeof createHarness>;
const actor = { accountId: 'admin_1', ip: '203.0.113.7' };
beforeEach(() => {
  h = createHarness();
});

const createPro = () =>
  h.catalog.createPlan(actor, {
    key: 'pro',
    name: 'Pro',
    description: 'For pros',
    rank: 2,
    modules: ['homebrew', 'remote'],
    features: [],
  });

describe('admin catalogue', () => {
  it('creating a plan creates its Paddle product and is audited', async () => {
    const plan = await createPro();
    expect(plan.paddleProductId).toMatch(/^pro_/);
    expect(h.gateway.callsTo('createProduct')).toEqual([
      [{ name: 'Pro', description: 'For pros' }],
    ]);
    expect(h.uow.state.audit).toEqual([
      expect.objectContaining({ action: 'plan.create', actorId: 'admin_1', ip: '203.0.113.7' }),
    ]);
  });

  it('rejects a duplicate key or rank (409)', async () => {
    await createPro();
    await expect(createPro()).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });

  it('adds a Paddle price and lists it publicly; deactivated prices disappear from pricing', async () => {
    const plan = await createPro();
    const price = await h.catalog.createPrice(actor, plan.id, {
      interval: 'month',
      amountMinor: 1500,
      currency: 'USD',
      trialDays: 7,
    });
    const pub = await h.catalog.publicCatalogue();
    expect(pub.plans).toEqual([
      expect.objectContaining({
        key: 'pro',
        prices: [expect.objectContaining({ priceId: price.paddlePriceId, amountMinor: 1500 })],
      }),
    ]);

    await h.catalog.setPriceActive(actor, price.id, false);
    expect(h.gateway.callsTo('setPriceActive')).toEqual([[price.paddlePriceId, false]]);
    expect((await h.catalog.publicCatalogue()).plans).toEqual([]);
  });

  it('renaming a plan updates the Paddle product too', async () => {
    const plan = await createPro();
    await h.catalog.updatePlan(actor, plan.id, { name: 'Pro+' });
    expect(h.gateway.callsTo('updateProduct')).toEqual([[plan.paddleProductId, { name: 'Pro+' }]]);
  });

  it('a Paddle failure leaves no half-created plan behind', async () => {
    h.gateway.failNext.add('createProduct');
    await expect(createPro()).rejects.toThrow();
    expect(h.uow.state.plans.size).toBe(0);
  });
});
