import type {
  BillingEvent,
  BillingGateway,
  CatalogGateway,
  ChangePreview,
  EffectiveFrom,
} from '@/modules/billing/billing.gateway';

/**
 * Fake Paddle. Webhook signature = the literal 'valid'; the body is the
 * BillingEvent as JSON. Every call is recorded so tests can assert on it.
 */
export class FakeGateway implements BillingGateway, CatalogGateway {
  calls: { op: string; args: unknown[] }[] = [];
  /** Make the next call to `op` throw (simulates a Paddle outage). */
  failNext = new Set<string>();
  private seq = 0;

  private record(op: string, ...args: unknown[]) {
    if (this.failNext.delete(op)) return Promise.reject(new Error(`${op} failed`));
    this.calls.push({ op, args });
    return Promise.resolve();
  }
  callsTo(op: string) {
    return this.calls.filter((c) => c.op === op).map((c) => c.args);
  }
  private nextId(prefix: string) {
    return `${prefix}_${String(++this.seq).padStart(12, '0')}`;
  }

  parseWebhook(rawBody: string, signature: string): Promise<BillingEvent> {
    if (signature !== 'valid') return Promise.reject(new Error('bad signature'));
    return Promise.resolve(
      JSON.parse(rawBody, (k: string, v: unknown) =>
        typeof v === 'string' && k.endsWith('At') ? new Date(v) : v,
      ) as BillingEvent,
    );
  }

  async createPortalUrl(customerId: string, subscriptionIds: string[]) {
    await this.record('portal', customerId, subscriptionIds);
    return `https://portal.example/${customerId}`;
  }

  async ensureCustomer(email: string, name: string | null) {
    await this.record('ensureCustomer', email, name);
    return 'ctm_fake_customer';
  }

  async createCheckout(input: {
    customerId: string;
    priceId: string;
    discountId: string | null;
    customData: Record<string, string>;
  }) {
    await this.record('createCheckout', input);
    return { transactionId: this.nextId('txn') };
  }

  async previewPriceChange(
    subscriptionId: string,
    priceId: string,
    prorate: boolean,
  ): Promise<ChangePreview> {
    await this.record('previewPriceChange', subscriptionId, priceId, prorate);
    return {
      immediate: { action: 'charge', amount: '1000', currency: 'USD' },
      nextRenewal: { amount: '3000', currency: 'USD' },
    };
  }

  changePrice(subscriptionId: string, priceId: string, prorate: boolean) {
    return this.record('changePrice', subscriptionId, priceId, prorate);
  }
  cancel(subscriptionId: string, effectiveFrom: EffectiveFrom) {
    return this.record('cancel', subscriptionId, effectiveFrom);
  }
  pause(subscriptionId: string, effectiveFrom: EffectiveFrom) {
    return this.record('pause', subscriptionId, effectiveFrom);
  }
  resume(subscriptionId: string) {
    return this.record('resume', subscriptionId);
  }

  async createProduct(input: { name: string; description: string }) {
    await this.record('createProduct', input);
    return this.nextId('pro');
  }
  updateProduct(productId: string, input: { name?: string; description?: string }) {
    return this.record('updateProduct', productId, input);
  }
  async createPrice(input: unknown) {
    await this.record('createPrice', input);
    return this.nextId('pri');
  }
  setPriceActive(priceId: string, active: boolean) {
    return this.record('setPriceActive', priceId, active);
  }
  async createDiscount(input: unknown) {
    await this.record('createDiscount', input);
    return this.nextId('dsc');
  }
  setDiscountActive(discountId: string, active: boolean) {
    return this.record('setDiscountActive', discountId, active);
  }
}
