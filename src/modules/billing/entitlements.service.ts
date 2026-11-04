import type { Repositories } from '@/db/unitOfWork';
import {
  resolvePlan,
  type CatalogPlan,
  type EntitlementPolicy,
} from '@/domain/entitlements/entitlements';
import type { Plan } from '@/generated/prisma/client';
import type { Clock } from '@/shared/clock';

export const toCatalogPlan = (p: Plan): CatalogPlan => ({
  id: p.id,
  key: p.key,
  name: p.name,
  rank: p.rank,
  modules: p.modules,
  features: p.features,
});

/**
 * "What can this account use right now?" — from the synced subscription mirror
 * and the admin-managed catalogue. Deactivating a plan stops new sales only;
 * existing subscribers keep what they pay for.
 */
export class EntitlementsService {
  constructor(
    private readonly policy: EntitlementPolicy,
    private readonly clock: Clock,
  ) {}

  async planFor(repos: Repositories, accountId: string): Promise<CatalogPlan | null> {
    const subs = await repos.subscriptions.listByAccount(accountId);
    const priceIds = new Set(
      subs.flatMap((s) => [s.priceId, s.graceFromPriceId]).filter((id): id is string => !!id),
    );
    const plans = new Map<string, CatalogPlan>();
    for (const priceId of priceIds) {
      const price = await repos.catalog.findPriceByPaddleId(priceId);
      if (price) plans.set(priceId, toCatalogPlan(price.plan));
    }
    return resolvePlan(subs, (id) => plans.get(id) ?? null, this.policy, this.clock.now());
  }
}
