import { addDays } from '@/shared/clock';

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';

/** A plan as entitlement sees it (from the admin-managed catalogue). */
export interface CatalogPlan {
  id: string;
  key: string;
  name: string;
  rank: number;
  modules: readonly string[];
  features: readonly string[];
}

/** The subscription facts entitlement depends on — nothing Paddle-specific. */
export interface SubscriptionFacts {
  status: SubscriptionStatus;
  priceId: string;
  currentPeriodEndsAt: Date | null;
  /** After an applied downgrade: the previous price stays entitled until graceUntil. */
  graceFromPriceId?: string | null;
  graceUntil?: Date | null;
}

export interface EntitlementPolicy {
  pastDueGraceDays: number;
}

/** Resolves a Paddle price id to its plan (null = not one of our plans). */
export type PlanLookup = (priceId: string) => CatalogPlan | null;

/**
 * Is this subscription currently paying for access? (Paddle's recommended gate)
 * - active / trialing → yes.
 * - past_due → yes during a grace window after the period end (Paddle is
 *   retrying the card); the website shows an "update payment" banner.
 * - paused / canceled → no. `canceled` is terminal; a user who pressed
 *   cancel stays `active` with a scheduled change until the period ends.
 */
export function isEntitling(sub: SubscriptionFacts, policy: EntitlementPolicy, now: Date): boolean {
  switch (sub.status) {
    case 'active':
    case 'trialing':
      return true;
    case 'past_due':
      return (
        sub.currentPeriodEndsAt !== null &&
        now < addDays(sub.currentPeriodEndsAt, policy.pastDueGraceDays)
      );
    case 'paused':
    case 'canceled':
      return false;
  }
}

/**
 * The highest-ranked plan any of the account's subscriptions grants right
 * now, or null: no subscription → nothing unlocked (no free tier).
 */
export function resolvePlan(
  subs: readonly SubscriptionFacts[],
  lookup: PlanLookup,
  policy: EntitlementPolicy,
  now: Date,
): CatalogPlan | null {
  let best: CatalogPlan | null = null;
  const consider = (priceId: string | null | undefined) => {
    const plan = priceId ? lookup(priceId) : null;
    if (plan && (!best || plan.rank > best.rank)) best = plan;
  };
  for (const sub of subs) {
    if (!isEntitling(sub, policy, now)) continue;
    consider(sub.priceId);
    // A downgrade never takes away what was paid for: old plan until period end.
    if (sub.graceUntil && now < sub.graceUntil) consider(sub.graceFromPriceId);
  }
  return best;
}
