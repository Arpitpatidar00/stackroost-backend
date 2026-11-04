import type { EventEntity } from '@paddle/paddle-node-sdk';
import { describe, expect, it } from 'vitest';
import { toBillingEvent } from './paddle.mapper';

// Shaped like the SDK's deserialised events (camelCase), cast for the test.
const event = (eventType: string, data: unknown) =>
  ({
    eventId: 'evt_1',
    eventType,
    occurredAt: '2026-11-02T10:00:00Z',
    data,
  }) as unknown as EventEntity;

describe('toBillingEvent', () => {
  it('maps a subscription event with plan, period, scheduled change and accountId', () => {
    const e = toBillingEvent(
      event('subscription.updated', {
        id: 'sub_1',
        customerId: 'ctm_1',
        status: 'active',
        items: [{ price: { id: 'pri_pro_m', productId: 'pro_1' } }],
        currentBillingPeriod: { startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z' },
        scheduledChange: { action: 'cancel', effectiveAt: '2026-12-01T00:00:00Z' },
        customData: { accountId: 'acc_1', accountSig: 'sig_1' },
      }),
    );
    expect(e).toEqual({
      eventId: 'evt_1',
      eventType: 'subscription.updated',
      occurredAt: new Date('2026-11-02T10:00:00Z'),
      kind: 'subscription',
      subscription: {
        id: 'sub_1',
        customerId: 'ctm_1',
        status: 'active',
        priceId: 'pri_pro_m',
        productId: 'pro_1',
        currentPeriodEndsAt: new Date('2026-12-01T00:00:00Z'),
        scheduledChange: { action: 'cancel', effectiveAt: new Date('2026-12-01T00:00:00Z') },
        accountId: 'acc_1',
        accountSig: 'sig_1',
      },
    });
  });

  it('tolerates missing optional data (no period, no custom data)', () => {
    const e = toBillingEvent(
      event('subscription.created', {
        id: 'sub_2',
        customerId: 'ctm_2',
        status: 'trialing',
        items: [],
        currentBillingPeriod: null,
        scheduledChange: null,
        customData: { accountId: 42 },
      }),
    );
    expect(e.kind === 'subscription' && e.subscription).toMatchObject({
      priceId: '',
      currentPeriodEndsAt: null,
      scheduledChange: null,
      accountId: null,
      accountSig: null,
    });
  });

  it('maps customer events', () => {
    const e = toBillingEvent(event('customer.updated', { id: 'ctm_1', email: 'a@b.co' }));
    expect(e).toMatchObject({ kind: 'customer', customer: { id: 'ctm_1', email: 'a@b.co' } });
  });

  it('marks events we do not handle as ignored (acknowledged, not failed)', () => {
    expect(toBillingEvent(event('payout.paid', {})).kind).toBe('ignored');
  });
});
