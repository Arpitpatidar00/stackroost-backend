/** Admin promo codes: canonical form + "can this code be used for this plan now?". */

export const COUPON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export const normalizeCouponCode = (code: string) => code.trim().toUpperCase();

export interface CouponRules {
  isActive: boolean;
  expiresAt: Date | null;
  /** Empty = every plan. */
  planIds: readonly string[];
}

export type CouponRejection = 'inactive' | 'expired' | 'not_for_plan';

/**
 * Our pre-check before opening checkout (fast, friendly errors). Paddle stays
 * authoritative and enforces usage limits and expiry again at payment time.
 */
export function couponRejection(
  coupon: CouponRules,
  planId: string,
  now: Date,
): CouponRejection | null {
  if (!coupon.isActive) return 'inactive';
  if (coupon.expiresAt && coupon.expiresAt <= now) return 'expired';
  if (coupon.planIds.length > 0 && !coupon.planIds.includes(planId)) return 'not_for_plan';
  return null;
}
