import type { UnitOfWork } from '@/db/unitOfWork';
import { isUniqueViolation } from '@/db/prisma';
import type { AuditService, Actor } from '@/modules/audit/audit.service';
import type { CatalogGateway } from '@/modules/billing/billing.gateway';
import { AppError } from '@/shared/errors/AppError';
import type { PlanInput, PlanWithPrices } from './catalog.repository';

export interface CheckoutConfig {
  environment: 'sandbox' | 'production';
  clientToken: string;
}

const publicPlan = (p: PlanWithPrices) => ({
  key: p.key,
  name: p.name,
  description: p.description,
  rank: p.rank,
  modules: p.modules,
  features: p.features,
  prices: p.prices.map((price) => ({
    priceId: price.paddlePriceId,
    interval: price.interval,
    amountMinor: price.amountMinor,
    currency: price.currency,
  })),
});

/**
 * The plan catalogue. Public read for the pricing page; admin writes go to
 * Paddle first (products/prices are Paddle's) and are mirrored here.
 */
export class CatalogService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly gateway: CatalogGateway,
    private readonly audit: AuditService,
    private readonly checkout: CheckoutConfig,
  ) {}

  async publicCatalogue() {
    const plans = await this.uow.repos.catalog.listPlans({ activeOnly: true });
    return {
      plans: plans.filter((p) => p.prices.length > 0).map(publicPlan),
      // Paddle.js on the website initialises with these (the client token is public by design).
      checkout: this.checkout,
    };
  }

  listPlans() {
    return this.uow.repos.catalog.listPlans({ activeOnly: false });
  }

  async createPlan(actor: Actor, input: PlanInput) {
    const productId = await this.gateway.createProduct({
      name: input.name,
      description: input.description,
    });
    try {
      return await this.uow.transaction(async (tx) => {
        const plan = await tx.catalog.createPlan(input);
        await tx.catalog.setPlanProduct(plan.id, productId);
        await this.audit.record(
          tx,
          actor,
          'plan.create',
          { type: 'plan', id: plan.id },
          { ...input, productId },
        );
        return { ...plan, paddleProductId: productId };
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw AppError.conflict('A plan with that key or rank already exists.');
      throw e;
    }
  }

  async updatePlan(
    actor: Actor,
    planId: string,
    patch: Partial<Omit<PlanInput, 'key'>> & { isActive?: boolean },
  ) {
    const plan = await this.uow.repos.catalog.findPlanById(planId);
    if (!plan) throw AppError.notFound('Plan');
    if (plan.paddleProductId && (patch.name !== undefined || patch.description !== undefined)) {
      await this.gateway.updateProduct(plan.paddleProductId, {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description }),
      });
    }
    try {
      return await this.uow.transaction(async (tx) => {
        const updated = await tx.catalog.updatePlan(planId, patch);
        await this.audit.record(tx, actor, 'plan.update', { type: 'plan', id: planId }, patch);
        return updated;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict('Another plan already uses that rank.');
      throw e;
    }
  }

  async createPrice(
    actor: Actor,
    planId: string,
    input: {
      interval: 'month' | 'year';
      amountMinor: number;
      currency: string;
      trialDays: number | null;
    },
  ) {
    const plan = await this.uow.repos.catalog.findPlanById(planId);
    if (!plan) throw AppError.notFound('Plan');
    let productId = plan.paddleProductId;
    if (!productId) {
      productId = await this.gateway.createProduct({
        name: plan.name,
        description: plan.description,
      });
      await this.uow.repos.catalog.setPlanProduct(plan.id, productId);
    }
    const paddlePriceId = await this.gateway.createPrice({
      productId,
      description: `${plan.name} (${input.interval}ly)`,
      ...input,
    });
    return this.uow.transaction(async (tx) => {
      const price = await tx.catalog.createPrice({
        planId,
        paddlePriceId,
        interval: input.interval,
        amountMinor: input.amountMinor,
        currency: input.currency,
      });
      await this.audit.record(
        tx,
        actor,
        'price.create',
        { type: 'price', id: price.id },
        { planId, ...input, paddlePriceId },
      );
      return price;
    });
  }

  /** Deactivating stops new checkouts at this price; existing subscribers are unaffected. */
  async setPriceActive(actor: Actor, priceId: string, isActive: boolean) {
    const price = await this.uow.repos.catalog.findPriceById(priceId);
    if (!price) throw AppError.notFound('Price');
    await this.gateway.setPriceActive(price.paddlePriceId, isActive);
    return this.uow.transaction(async (tx) => {
      const updated = await tx.catalog.setPriceActive(priceId, isActive);
      await this.audit.record(tx, actor, isActive ? 'price.activate' : 'price.deactivate', {
        type: 'price',
        id: priceId,
      });
      return updated;
    });
  }

  /** A sellable price: exists, active, on an active plan. */
  async sellablePrice(paddlePriceId: string) {
    const price = await this.uow.repos.catalog.findPriceByPaddleId(paddlePriceId);
    if (!price?.isActive || !price.plan.isActive) {
      throw new AppError('PLAN_UNAVAILABLE', 'That plan is not available.', 422);
    }
    return price;
  }
}
