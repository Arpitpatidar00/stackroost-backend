import type { UnitOfWork } from '@/db/unitOfWork';
import type { BillingGateway } from '@/modules/billing/billing.gateway';
import type { EntitlementsService } from '@/modules/billing/entitlements.service';
import type { CatalogService } from '@/modules/catalog/catalog.service';
import { publicCoupon, type CouponsService } from '@/modules/coupons/coupons.service';
import type { Signer } from '@/shared/crypto/signed';
import { AppError } from '@/shared/errors/AppError';

export interface Buyer {
  accountId: string;
  email: string;
  name: string | null;
}

/** Binds a Paddle purchase to an account; verified by the webhook (no forged links). */
export const accountLink = (signer: Signer, accountId: string) => ({
  accountId,
  accountSig: signer.mac(`checkout:${accountId}`),
});

export const verifyAccountLink = (signer: Signer, accountId: string, sig: string) =>
  signer.verifyMac(`checkout:${accountId}`, sig);

/**
 * New subscriptions. The transaction is created server-side with the signed-in
 * account bound into custom data, so the purchase can only land on that account.
 * The website opens it with `Paddle.Checkout.open({ transactionId })`.
 */
export class CheckoutService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly gateway: BillingGateway,
    private readonly catalog: CatalogService,
    private readonly coupons: CouponsService,
    private readonly entitlements: EntitlementsService,
    private readonly signer: Signer,
  ) {}

  /** Lets the pricing page show "LAUNCH50: 50 % off" before paying. */
  async previewCoupon(code: string, priceId: string) {
    const price = await this.catalog.sellablePrice(priceId);
    return publicCoupon(await this.coupons.resolve(code, price.planId));
  }

  async start(buyer: Buyer, input: { priceId: string; couponCode?: string }) {
    const price = await this.catalog.sellablePrice(input.priceId);
    if (await this.entitlements.planFor(this.uow.repos, buyer.accountId)) {
      throw new AppError(
        'ALREADY_SUBSCRIBED',
        'You already have an active subscription. Change your plan instead.',
        409,
      );
    }
    const coupon = input.couponCode
      ? await this.coupons.resolve(input.couponCode, price.planId)
      : null;

    const customerId = await this.customerFor(buyer);
    const { transactionId } = await this.gateway.createCheckout({
      customerId,
      priceId: price.paddlePriceId,
      discountId: coupon?.paddleDiscountId ?? null,
      customData: accountLink(this.signer, buyer.accountId),
    });
    return { transactionId, coupon: coupon && publicCoupon(coupon) };
  }

  /** The account's Paddle customer: reuse the linked one, else create/find by email and link it. */
  private async customerFor(buyer: Buyer): Promise<string> {
    const [linked] = await this.uow.repos.customers.listByAccount(buyer.accountId);
    if (linked) return linked.id;
    const customerId = await this.gateway.ensureCustomer(buyer.email, buyer.name);
    await this.uow.repos.customers.upsert({
      id: customerId,
      email: buyer.email,
      accountId: buyer.accountId,
    });
    return customerId;
  }
}
