import type { SubscriptionStatus } from '@/domain/entitlements/entitlements';

/**
 * Ports to the payment provider. The Paddle adapter implements them
 * (integrations/paddle); tests use fakes. Services never see SDK types.
 */
export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  priceId: string;
  productId: string;
  currentPeriodEndsAt: Date | null;
  scheduledChange: { action: string; effectiveAt: Date } | null;
  /** From checkout custom data — trusted only with a valid `accountSig`. */
  accountId: string | null;
  accountSig: string | null;
}

interface EventBase {
  eventId: string;
  eventType: string;
  occurredAt: Date;
}

export type BillingEvent =
  | (EventBase & { kind: 'subscription'; subscription: SubscriptionSnapshot })
  | (EventBase & { kind: 'customer'; customer: { id: string; email: string } })
  | (EventBase & { kind: 'ignored' });

export interface Money {
  /** Minor units as a string ("1250" = 12.50). */
  amount: string;
  currency: string;
}

export interface ChangePreview {
  /** What the customer pays now (or is credited) for the change. */
  immediate: Money & { action: 'charge' | 'credit' };
  /** The next renewal after the change. */
  nextRenewal: Money | null;
}

export type EffectiveFrom = 'immediately' | 'next_billing_period';

export interface BillingGateway {
  /** Verifies the signature over the RAW body and parses the event. Throws if invalid. */
  parseWebhook(rawBody: string, signature: string): Promise<BillingEvent>;
  /** Hosted self-service portal (invoices, payment method, cancel). */
  createPortalUrl(customerId: string, subscriptionIds: string[]): Promise<string>;
  /** Existing Paddle customer for this email, or a new one. */
  ensureCustomer(email: string, name: string | null): Promise<string>;
  /** Server-created transaction the website opens with Paddle.js (`transactionId`). */
  createCheckout(input: {
    customerId: string;
    priceId: string;
    discountId: string | null;
    customData: Record<string, string>;
  }): Promise<{ transactionId: string }>;
  previewPriceChange(
    subscriptionId: string,
    priceId: string,
    prorate: boolean,
  ): Promise<ChangePreview>;
  /** prorate=true → charge the difference now; false → swap without billing (downgrade at renewal). */
  changePrice(subscriptionId: string, priceId: string, prorate: boolean): Promise<void>;
  cancel(subscriptionId: string, effectiveFrom: EffectiveFrom): Promise<void>;
  pause(subscriptionId: string, effectiveFrom: EffectiveFrom): Promise<void>;
  resume(subscriptionId: string): Promise<void>;
}

/** Admin catalogue operations (products, prices, discounts). */
export interface CatalogGateway {
  createProduct(input: { name: string; description: string }): Promise<string>;
  updateProduct(productId: string, input: { name?: string; description?: string }): Promise<void>;
  createPrice(input: {
    productId: string;
    description: string;
    amountMinor: number;
    currency: string;
    interval: 'month' | 'year';
    trialDays: number | null;
  }): Promise<string>;
  setPriceActive(priceId: string, active: boolean): Promise<void>;
  createDiscount(input: {
    code: string;
    description: string;
    type: 'percentage' | 'flat';
    amount: string;
    currency: string | null;
    recurring: boolean;
    maxRecurringIntervals: number | null;
    usageLimit: number | null;
    expiresAt: Date | null;
    restrictToPriceIds: string[] | null;
  }): Promise<string>;
  setDiscountActive(discountId: string, active: boolean): Promise<void>;
}
