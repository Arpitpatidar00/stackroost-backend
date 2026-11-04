import type { UnitOfWork } from '@/db/unitOfWork';
import type { SubscriptionStatus } from '@/generated/prisma/client';
import type { AuditService, Actor } from '@/modules/audit/audit.service';
import type { BillingGateway, EffectiveFrom } from '@/modules/billing/billing.gateway';
import type { SubscriptionWithAccount } from '@/modules/billing/billing.repository';
import { AppError } from '@/shared/errors/AppError';
import type { PageRequest } from '@/shared/http/pagination';

const view = (s: SubscriptionWithAccount) => ({
  id: s.id,
  status: s.status,
  priceId: s.priceId,
  currentPeriodEndsAt: s.currentPeriodEndsAt?.toISOString() ?? null,
  scheduledChange: s.scheduledChangeAction
    ? { action: s.scheduledChangeAction, effectiveAt: s.scheduledChangeAt?.toISOString() ?? null }
    : null,
  pendingPriceId: s.pendingPriceId,
  customerId: s.customerId,
  account: s.customer.account && { id: s.customer.account.id, email: s.customer.account.email },
  updatedAt: s.updatedAt.toISOString(),
});

/**
 * Admin subscription management. Actions go to Paddle (the source of truth);
 * our mirror updates when its webhook arrives. Every action is audited.
 */
export class AdminSubscriptionsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly gateway: BillingGateway,
    private readonly audit: AuditService,
  ) {}

  async list(filter: { status?: SubscriptionStatus; search?: string }, page: PageRequest) {
    const { items, total } = await this.uow.repos.subscriptions.adminList(filter, page);
    return { items: items.map(view), total };
  }

  async detail(id: string) {
    return view(await this.find(id));
  }

  async cancel(actor: Actor, id: string, effectiveFrom: EffectiveFrom) {
    await this.find(id);
    await this.gateway.cancel(id, effectiveFrom);
    await this.log(actor, 'subscription.cancel', id, { effectiveFrom });
  }

  async pause(actor: Actor, id: string, effectiveFrom: EffectiveFrom) {
    await this.find(id);
    await this.gateway.pause(id, effectiveFrom);
    await this.log(actor, 'subscription.pause', id, { effectiveFrom });
  }

  async resume(actor: Actor, id: string) {
    await this.find(id);
    await this.gateway.resume(id);
    await this.log(actor, 'subscription.resume', id);
  }

  private async find(id: string) {
    const sub = await this.uow.repos.subscriptions.findById(id);
    if (!sub) throw AppError.notFound('Subscription');
    return sub;
  }

  private log(actor: Actor, action: string, id: string, metadata: Record<string, unknown> = {}) {
    return this.uow.transaction((tx) =>
      this.audit.record(tx, actor, action, { type: 'subscription', id }, metadata),
    );
  }
}
