import type { UnitOfWork } from '@/db/unitOfWork';
import {
  COUPON_CODE_PATTERN,
  couponRejection,
  normalizeCouponCode,
} from '@/domain/billing/coupons';
import type { Coupon } from '@/generated/prisma/client';
import type { AuditService, Actor } from '@/modules/audit/audit.service';
import type { CatalogGateway } from '@/modules/billing/billing.gateway';
import type { Clock } from '@/shared/clock';
import { AppError } from '@/shared/errors/AppError';
import type { PageRequest } from '@/shared/http/pagination';

export interface CouponInput {
  code: string;
  description: string;
  type: 'percentage' | 'flat';
  /** percentage: 1–100; flat: minor units. */
  amount: number;
  currency: string | null;
  recurring: boolean;
  maxRecurringIntervals: number | null;
  usageLimit: number | null;
  expiresAt: Date | null;
  planIds: string[];
}

const invalid = (reason: string) =>
  new AppError('COUPON_INVALID', 'That coupon code can’t be used for this plan.', 422, { reason });

/** Public shape (what the checkout page may show). */
export const publicCoupon = (c: Coupon) => ({
  code: c.code,
  type: c.type,
  amount: c.amount,
  currency: c.currency,
  recurring: c.recurring,
  maxRecurringIntervals: c.maxRecurringIntervals,
});

/**
 * Admin promo codes. Each is a Paddle discount (Paddle applies it, so tax and
 * invoices stay correct) mirrored here for fast validation and the admin list.
 */
export class CouponsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly gateway: CatalogGateway,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  list(filter: { active?: boolean }, page: PageRequest) {
    return this.uow.repos.coupons.list(filter, page);
  }

  async create(actor: Actor, input: CouponInput): Promise<Coupon> {
    const code = normalizeCouponCode(input.code);
    if (!COUPON_CODE_PATTERN.test(code))
      throw AppError.validation([{ path: 'code', message: 'invalid code' }]);
    if (input.type === 'percentage' && (input.amount < 1 || input.amount > 100)) {
      throw AppError.validation([{ path: 'amount', message: 'percentage must be 1–100' }]);
    }
    if (input.type === 'flat' && !input.currency) {
      throw AppError.validation([{ path: 'currency', message: 'required for flat coupons' }]);
    }
    if (await this.uow.repos.coupons.findByCode(code))
      throw AppError.conflict('That code already exists.');

    const restrictToPriceIds = await this.priceIdsForPlans(input.planIds);
    const amount = String(input.amount);
    const paddleDiscountId = await this.gateway.createDiscount({
      code,
      description: input.description,
      type: input.type,
      amount,
      currency: input.type === 'flat' ? input.currency : null,
      recurring: input.recurring,
      maxRecurringIntervals: input.recurring ? input.maxRecurringIntervals : null,
      usageLimit: input.usageLimit,
      expiresAt: input.expiresAt,
      restrictToPriceIds,
    });

    return this.uow.transaction(async (tx) => {
      const coupon = await tx.coupons.create({
        code,
        paddleDiscountId,
        type: input.type,
        amount,
        currency: input.type === 'flat' ? input.currency : null,
        recurring: input.recurring,
        maxRecurringIntervals: input.recurring ? input.maxRecurringIntervals : null,
        usageLimit: input.usageLimit,
        expiresAt: input.expiresAt,
        planIds: input.planIds,
        createdById: actor.accountId,
      });
      await this.audit.record(
        tx,
        actor,
        'coupon.create',
        { type: 'coupon', id: coupon.id },
        { code, paddleDiscountId },
      );
      return coupon;
    });
  }

  async setActive(actor: Actor, couponId: string, isActive: boolean) {
    const coupon = await this.uow.repos.coupons.findById(couponId);
    if (!coupon) throw AppError.notFound('Coupon');
    await this.gateway.setDiscountActive(coupon.paddleDiscountId, isActive);
    return this.uow.transaction(async (tx) => {
      const updated = await tx.coupons.setActive(couponId, isActive);
      await this.audit.record(tx, actor, isActive ? 'coupon.activate' : 'coupon.deactivate', {
        type: 'coupon',
        id: couponId,
      });
      return updated;
    });
  }

  /** Checkout: the coupon for this code and plan, or COUPON_INVALID (same message for every reason). */
  async resolve(rawCode: string, planId: string): Promise<Coupon> {
    const coupon = await this.uow.repos.coupons.findByCode(normalizeCouponCode(rawCode));
    if (!coupon) throw invalid('unknown');
    const rejection = couponRejection(coupon, planId, this.clock.now());
    if (rejection) throw invalid(rejection);
    return coupon;
  }

  private async priceIdsForPlans(planIds: string[]): Promise<string[] | null> {
    if (planIds.length === 0) return null;
    const ids: string[] = [];
    for (const planId of planIds) {
      const plan = await this.uow.repos.catalog.findPlanById(planId);
      if (!plan) throw AppError.notFound(`Plan ${planId}`);
      ids.push(...plan.prices.map((p) => p.paddlePriceId));
    }
    if (ids.length === 0) {
      throw new AppError('PLAN_UNAVAILABLE', 'Those plans have no prices to discount yet.', 422);
    }
    return ids;
  }
}
