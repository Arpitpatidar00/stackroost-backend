/**
 * What happens when a subscriber picks another price:
 * - upgrade (higher-ranked plan): Paddle prorates; the user pays only the
 *   difference for the rest of the period, immediately, and gets the plan now.
 * - interval switch (same plan, e.g. monthly → yearly): also immediate + prorated.
 * - downgrade (lower-ranked plan): scheduled for the end of the paid period —
 *   they keep what they paid for; nothing is refunded.
 */
export type PlanChange = 'upgrade' | 'interval_switch' | 'downgrade' | 'no_change';

export function classifyPlanChange(
  current: { planRank: number; priceId: string },
  target: { planRank: number; priceId: string },
): PlanChange {
  if (current.priceId === target.priceId) return 'no_change';
  if (target.planRank > current.planRank) return 'upgrade';
  if (target.planRank < current.planRank) return 'downgrade';
  return 'interval_switch';
}

/** Changes that bill and apply right away (vs. scheduled downgrades). */
export const isImmediate = (c: PlanChange) => c === 'upgrade' || c === 'interval_switch';
