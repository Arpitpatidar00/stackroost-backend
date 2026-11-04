import { describe, expect, it } from 'vitest';
import { couponRejection, normalizeCouponCode, COUPON_CODE_PATTERN } from './coupons';
import { classifyPlanChange, isImmediate } from './planChange';

describe('classifyPlanChange', () => {
  const pro = { planRank: 2, priceId: 'pri_pro_m' };
  it.each([
    [{ planRank: 3, priceId: 'pri_max_m' }, 'upgrade'],
    [{ planRank: 1, priceId: 'pri_basic_m' }, 'downgrade'],
    [{ planRank: 2, priceId: 'pri_pro_y' }, 'interval_switch'],
    [{ planRank: 2, priceId: 'pri_pro_m' }, 'no_change'],
  ] as const)('pro → %o is %s', (target, expected) => {
    expect(classifyPlanChange(pro, target)).toBe(expected);
  });

  it('only upgrades and interval switches apply immediately', () => {
    expect(isImmediate('upgrade')).toBe(true);
    expect(isImmediate('interval_switch')).toBe(true);
    expect(isImmediate('downgrade')).toBe(false);
  });
});

describe('coupons', () => {
  const now = new Date('2026-11-02T00:00:00Z');
  const rules = { isActive: true, expiresAt: null, planIds: [] as string[] };

  it('normalises codes and validates their shape', () => {
    expect(normalizeCouponCode('  launch50 ')).toBe('LAUNCH50');
    expect(COUPON_CODE_PATTERN.test('LAUNCH50')).toBe(true);
    expect(COUPON_CODE_PATTERN.test('A')).toBe(false);
    expect(COUPON_CODE_PATTERN.test('BAD CODE')).toBe(false);
  });

  it('accepts an active, unexpired code for any plan when unrestricted', () => {
    expect(couponRejection(rules, 'plan_pro', now)).toBeNull();
  });

  it('rejects inactive, expired, or other-plan codes', () => {
    expect(couponRejection({ ...rules, isActive: false }, 'plan_pro', now)).toBe('inactive');
    expect(couponRejection({ ...rules, expiresAt: now }, 'plan_pro', now)).toBe('expired');
    expect(couponRejection({ ...rules, planIds: ['plan_max'] }, 'plan_pro', now)).toBe(
      'not_for_plan',
    );
  });
});
