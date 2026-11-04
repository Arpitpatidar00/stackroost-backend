import type { UnitOfWork } from '@/db/unitOfWork';

const PAYING = new Set(['active', 'trialing', 'past_due']);

/** Dashboard numbers, computed from the mirror (no Paddle API calls). */
export class AdminInsightsService {
  constructor(private readonly uow: UnitOfWork) {}

  async overview() {
    const [rows, plans, accounts] = await Promise.all([
      this.uow.repos.subscriptions.countByStatusAndPrice(),
      this.uow.repos.catalog.listPlans({ activeOnly: false }),
      this.uow.repos.accounts.list({}, { page: 1, limit: 1 }),
    ]);
    const priceIndex = new Map(
      plans.flatMap((plan) =>
        plan.prices.map((price) => [price.paddlePriceId, { plan, price }] as const),
      ),
    );

    const byPlan = new Map<string, Record<string, number>>();
    /** Monthly recurring revenue per currency, in minor units (list price; excludes discounts). */
    const mrrMinor: Record<string, number> = {};
    for (const row of rows) {
      const entry = priceIndex.get(row.priceId);
      const key = entry?.plan.key ?? 'unknown';
      const counts = byPlan.get(key) ?? {};
      counts[row.status] = (counts[row.status] ?? 0) + row.count;
      byPlan.set(key, counts);
      if (entry && PAYING.has(row.status)) {
        const monthly =
          entry.price.interval === 'year' ? entry.price.amountMinor / 12 : entry.price.amountMinor;
        mrrMinor[entry.price.currency] = Math.round(
          (mrrMinor[entry.price.currency] ?? 0) + monthly * row.count,
        );
      }
    }
    return {
      accounts: accounts.total,
      subscriptionsByPlan: Object.fromEntries(byPlan),
      mrrMinor,
    };
  }
}
