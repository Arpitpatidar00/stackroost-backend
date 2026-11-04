import type { Plan, PlanPrice } from '@/generated/prisma/client';
import type { DbClient } from '@/db/prisma';

export type PlanWithPrices = Plan & { prices: PlanPrice[] };

export interface PlanInput {
  key: string;
  name: string;
  description: string;
  rank: number;
  modules: string[];
  features: string[];
}

export interface CatalogRepository {
  listPlans(opts: { activeOnly: boolean }): Promise<PlanWithPrices[]>;
  findPlanById(id: string): Promise<PlanWithPrices | null>;
  findPlanByKey(key: string): Promise<Plan | null>;
  findPlanByRank(rank: number): Promise<Plan | null>;
  createPlan(input: PlanInput): Promise<Plan>;
  updatePlan(
    id: string,
    input: Partial<Omit<PlanInput, 'key'>> & { isActive?: boolean },
  ): Promise<Plan>;
  setPlanProduct(id: string, paddleProductId: string): Promise<void>;
  findPriceById(id: string): Promise<PlanPrice | null>;
  findPriceByPaddleId(paddlePriceId: string): Promise<(PlanPrice & { plan: Plan }) | null>;
  createPrice(
    input: Omit<PlanPrice, 'id' | 'isActive' | 'createdAt' | 'updatedAt'>,
  ): Promise<PlanPrice>;
  setPriceActive(id: string, isActive: boolean): Promise<PlanPrice>;
}

const withPrices = { prices: { orderBy: { amountMinor: 'asc' as const } } };

export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly db: DbClient) {}

  listPlans({ activeOnly }: { activeOnly: boolean }) {
    return this.db.plan.findMany({
      where: activeOnly ? { isActive: true } : {},
      include: {
        prices: { where: activeOnly ? { isActive: true } : {}, orderBy: { amountMinor: 'asc' } },
      },
      orderBy: { rank: 'asc' },
    });
  }

  findPlanById(id: string) {
    return this.db.plan.findUnique({ where: { id }, include: withPrices });
  }

  findPlanByKey(key: string) {
    return this.db.plan.findUnique({ where: { key } });
  }

  findPlanByRank(rank: number) {
    return this.db.plan.findUnique({ where: { rank } });
  }

  createPlan(input: PlanInput) {
    return this.db.plan.create({ data: input });
  }

  updatePlan(id: string, input: Partial<Omit<PlanInput, 'key'>> & { isActive?: boolean }) {
    return this.db.plan.update({ where: { id }, data: input });
  }

  async setPlanProduct(id: string, paddleProductId: string) {
    await this.db.plan.update({ where: { id }, data: { paddleProductId } });
  }

  findPriceById(id: string) {
    return this.db.planPrice.findUnique({ where: { id } });
  }

  findPriceByPaddleId(paddlePriceId: string) {
    return this.db.planPrice.findUnique({ where: { paddlePriceId }, include: { plan: true } });
  }

  createPrice(input: Omit<PlanPrice, 'id' | 'isActive' | 'createdAt' | 'updatedAt'>) {
    return this.db.planPrice.create({ data: input });
  }

  setPriceActive(id: string, isActive: boolean) {
    return this.db.planPrice.update({ where: { id }, data: { isActive } });
  }
}
