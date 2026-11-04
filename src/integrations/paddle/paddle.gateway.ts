import { Environment, LogLevel, Paddle } from '@paddle/paddle-node-sdk';
import type {
  BillingEvent,
  BillingGateway,
  CatalogGateway,
  ChangePreview,
  EffectiveFrom,
} from '@/modules/billing/billing.gateway';
import { AppError } from '@/shared/errors/AppError';
import { toBillingEvent } from './paddle.mapper';

/** Paddle's currency union, derived from the SDK signature (we validate ISO codes at the API). */
type Currency = Parameters<Paddle['prices']['create']>[0]['unitPrice']['currencyCode'];

/** Any Paddle API failure surfaces as one stable error; the cause goes to logs only. */
async function upstream<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw new AppError('UPSTREAM_FAILED', `Payment provider error: ${what}. Try again.`, 502, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** Paddle adapter for both ports. One SDK instance per process (composition root). */
export class PaddleGateway implements BillingGateway, CatalogGateway {
  private readonly paddle: Paddle;

  constructor(
    apiKey: string,
    environment: 'sandbox' | 'production',
    private readonly webhookSecret: string,
  ) {
    this.paddle = new Paddle(apiKey, {
      environment: environment === 'production' ? Environment.production : Environment.sandbox,
      logLevel: LogLevel.error,
    });
  }

  // ---- BillingGateway ----

  async parseWebhook(rawBody: string, signature: string): Promise<BillingEvent> {
    // Verifies the HMAC over the exact bytes Paddle signed + the timestamp.
    const event = await this.paddle.webhooks.unmarshal(rawBody, this.webhookSecret, signature);
    return toBillingEvent(event);
  }

  createPortalUrl(customerId: string, subscriptionIds: string[]) {
    return upstream('open the billing portal', async () => {
      const session = await this.paddle.customerPortalSessions.create(customerId, subscriptionIds);
      return session.urls.general.overview;
    });
  }

  ensureCustomer(email: string, name: string | null) {
    return upstream('create the customer', async () => {
      // Paddle customers are unique per email: reuse before creating.
      for await (const existing of this.paddle.customers.list({ email: [email] })) {
        return existing.id;
      }
      return (await this.paddle.customers.create({ email, name })).id;
    });
  }

  createCheckout(input: {
    customerId: string;
    priceId: string;
    discountId: string | null;
    customData: Record<string, string>;
  }) {
    return upstream('start checkout', async () => {
      const txn = await this.paddle.transactions.create({
        items: [{ priceId: input.priceId, quantity: 1 }],
        customerId: input.customerId,
        discountId: input.discountId,
        customData: input.customData,
      });
      return { transactionId: txn.id };
    });
  }

  previewPriceChange(subscriptionId: string, priceId: string, prorate: boolean) {
    return upstream('preview the plan change', async (): Promise<ChangePreview> => {
      const preview = await this.paddle.subscriptions.previewUpdate(subscriptionId, {
        items: [{ priceId, quantity: 1 }],
        prorationBillingMode: prorate ? 'prorated_immediately' : 'do_not_bill',
      });
      const result = preview.updateSummary?.result;
      const next = preview.nextTransaction?.details.totals;
      return {
        immediate: {
          action: result?.action ?? 'charge',
          amount: result?.amount ?? '0',
          currency: result?.currencyCode ?? preview.currencyCode,
        },
        nextRenewal: next ? { amount: next.grandTotal, currency: next.currencyCode } : null,
      };
    });
  }

  changePrice(subscriptionId: string, priceId: string, prorate: boolean) {
    return upstream('change the plan', async () => {
      await this.paddle.subscriptions.update(subscriptionId, {
        items: [{ priceId, quantity: 1 }],
        prorationBillingMode: prorate ? 'prorated_immediately' : 'do_not_bill',
        // An upgrade whose payment fails must not grant the plan.
        ...(prorate && { onPaymentFailure: 'prevent_change' as const }),
      });
    });
  }

  cancel(subscriptionId: string, effectiveFrom: EffectiveFrom) {
    return upstream('cancel the subscription', async () => {
      await this.paddle.subscriptions.cancel(subscriptionId, { effectiveFrom });
    });
  }

  pause(subscriptionId: string, effectiveFrom: EffectiveFrom) {
    return upstream('pause the subscription', async () => {
      await this.paddle.subscriptions.pause(subscriptionId, { effectiveFrom });
    });
  }

  resume(subscriptionId: string) {
    return upstream('resume the subscription', async () => {
      await this.paddle.subscriptions.resume(subscriptionId, { effectiveFrom: 'immediately' });
    });
  }

  // ---- CatalogGateway ----

  createProduct(input: { name: string; description: string }) {
    return upstream('create the product', async () => {
      const p = await this.paddle.products.create({
        name: input.name,
        description: input.description,
        taxCategory: 'saas',
      });
      return p.id;
    });
  }

  updateProduct(productId: string, input: { name?: string; description?: string }) {
    return upstream('update the product', async () => {
      await this.paddle.products.update(productId, input);
    });
  }

  createPrice(input: {
    productId: string;
    description: string;
    amountMinor: number;
    currency: string;
    interval: 'month' | 'year';
    trialDays: number | null;
  }) {
    return upstream('create the price', async () => {
      const price = await this.paddle.prices.create({
        productId: input.productId,
        description: input.description,
        unitPrice: {
          amount: String(input.amountMinor),
          currencyCode: input.currency as Currency,
        },
        billingCycle: { interval: input.interval, frequency: 1 },
        trialPeriod: input.trialDays ? { interval: 'day', frequency: input.trialDays } : null,
      });
      return price.id;
    });
  }

  setPriceActive(priceId: string, active: boolean) {
    return upstream('update the price', async () => {
      await this.paddle.prices.update(priceId, { status: active ? 'active' : 'archived' });
    });
  }

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
  }) {
    return upstream('create the coupon', async () => {
      const d = await this.paddle.discounts.create({
        code: input.code,
        description: input.description,
        type: input.type,
        amount: input.amount,
        currencyCode: input.currency as Currency | null,
        enabledForCheckout: true,
        recur: input.recurring,
        maximumRecurringIntervals: input.maxRecurringIntervals,
        usageLimit: input.usageLimit,
        expiresAt: input.expiresAt?.toISOString() ?? null,
        restrictTo: input.restrictToPriceIds,
      });
      return d.id;
    });
  }

  setDiscountActive(discountId: string, active: boolean) {
    return upstream('update the coupon', async () => {
      await this.paddle.discounts.update(discountId, {
        status: active ? 'active' : 'archived',
        enabledForCheckout: active,
      });
    });
  }
}
