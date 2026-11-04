import { EventName, type EventEntity } from '@paddle/paddle-node-sdk';
import type { BillingEvent } from '@/modules/billing/billing.gateway';

const date = (iso: string | null | undefined) => (iso ? new Date(iso) : null);

const stringField = (customData: unknown, key: string): string | null => {
  if (typeof customData !== 'object' || customData === null) return null;
  const v = (customData as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
};

/** Paddle SDK event → provider-neutral BillingEvent (anti-corruption layer). */
export function toBillingEvent(event: EventEntity): BillingEvent {
  const base = {
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: new Date(event.occurredAt),
  };

  switch (event.eventType) {
    case EventName.SubscriptionCreated:
    case EventName.SubscriptionUpdated:
    case EventName.SubscriptionCanceled:
    case EventName.SubscriptionActivated:
    case EventName.SubscriptionPastDue:
    case EventName.SubscriptionPaused:
    case EventName.SubscriptionResumed:
    case EventName.SubscriptionTrialing:
    case EventName.SubscriptionImported: {
      const s = event.data;
      // Single-product catalogue: the first item's price decides the plan.
      const price = s.items[0]?.price ?? null;
      return {
        ...base,
        kind: 'subscription',
        subscription: {
          id: s.id,
          customerId: s.customerId,
          status: s.status,
          priceId: price?.id ?? '',
          productId: price?.productId ?? '',
          currentPeriodEndsAt: date(s.currentBillingPeriod?.endsAt),
          scheduledChange: s.scheduledChange
            ? {
                action: s.scheduledChange.action,
                effectiveAt: new Date(s.scheduledChange.effectiveAt),
              }
            : null,
          accountId: stringField(s.customData, 'accountId'),
          accountSig: stringField(s.customData, 'accountSig'),
        },
      };
    }
    case EventName.CustomerCreated:
    case EventName.CustomerUpdated:
      return {
        ...base,
        kind: 'customer',
        customer: { id: event.data.id, email: event.data.email },
      };
    default:
      return { ...base, kind: 'ignored' };
  }
}
