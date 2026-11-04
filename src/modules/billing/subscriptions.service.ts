import type { UnitOfWork } from '@/db/unitOfWork';
import { classifyPlanChange, isImmediate, type PlanChange } from '@/domain/billing/planChange';
import { isEntitling, type EntitlementPolicy } from '@/domain/entitlements/entitlements';
import type { Subscription } from '@/generated/prisma/client';
import type { CatalogService } from '@/modules/catalog/catalog.service';
import type { Clock } from '@/shared/clock';
import { AppError } from '@/shared/errors/AppError';
import type { Logger } from '@/shared/logger';
import type { BillingGateway, ChangePreview } from './billing.gateway';

const invalidChange = (message: string) => new AppError('PLAN_CHANGE_INVALID', message, 409);

/**
 * Plan changes for an existing subscriber:
 * - upgrade / interval switch → Paddle prorates and charges the difference now;
 *   the plan applies immediately (and never if that payment fails);
 * - downgrade → scheduled; applied in Paddle just before the period ends
 *   (`do_not_bill`), the higher plan stays entitled until the paid period is over.
 */
export class SubscriptionsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly gateway: BillingGateway,
    private readonly catalog: CatalogService,
    private readonly policy: EntitlementPolicy,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly downgradeLeadMinutes: number,
  ) {}

  async preview(accountId: string, targetPriceId: string) {
    const { sub, change, target } = await this.plan(accountId, targetPriceId);
    if (!isImmediate(change)) {
      return {
        change,
        effectiveAt: sub.currentPeriodEndsAt?.toISOString() ?? null,
        dueNow: null,
        plan: target.plan.key,
      };
    }
    const preview: ChangePreview = await this.gateway.previewPriceChange(
      sub.id,
      target.paddlePriceId,
      true,
    );
    return {
      change,
      effectiveAt: 'now',
      dueNow: preview.immediate,
      nextRenewal: preview.nextRenewal,
      plan: target.plan.key,
    };
  }

  async change(accountId: string, targetPriceId: string) {
    const { sub, change, target } = await this.plan(accountId, targetPriceId);
    if (isImmediate(change)) {
      await this.gateway.changePrice(sub.id, target.paddlePriceId, true);
      // The webhook brings the new price; any earlier scheduled downgrade is superseded.
      await this.uow.repos.subscriptions.setPending(sub.id, null, this.clock.now());
      return { change, effectiveAt: 'now', plan: target.plan.key };
    }
    await this.uow.repos.subscriptions.setPending(sub.id, target.paddlePriceId, this.clock.now());
    return {
      change,
      effectiveAt: sub.currentPeriodEndsAt?.toISOString() ?? null,
      plan: target.plan.key,
    };
  }

  async cancelScheduledChange(accountId: string) {
    const sub = await this.current(accountId);
    if (!sub.pendingPriceId) throw invalidChange('There is no scheduled plan change.');
    await this.uow.repos.subscriptions.setPending(sub.id, null, this.clock.now());
  }

  /**
   * Worker: push due downgrades to Paddle before renewal so the next bill is
   * the lower price. One failure never blocks the others; it retries next run.
   */
  async applyDueDowngrades(): Promise<number> {
    const now = this.clock.now();
    const due = await this.uow.repos.subscriptions.dueDowngrades(
      new Date(now.getTime() + this.downgradeLeadMinutes * 60_000),
    );
    let applied = 0;
    for (const sub of due) {
      if (!sub.pendingPriceId || !sub.currentPeriodEndsAt) continue;
      try {
        await this.gateway.changePrice(sub.id, sub.pendingPriceId, false);
        await this.uow.repos.subscriptions.markDowngradeApplied(
          sub.id,
          sub.priceId,
          sub.currentPeriodEndsAt,
        );
        applied++;
      } catch (err) {
        this.log.error({ err, subscriptionId: sub.id }, 'scheduled downgrade failed; will retry');
      }
    }
    return applied;
  }

  private async current(accountId: string): Promise<Subscription> {
    const subs = await this.uow.repos.subscriptions.listByAccount(accountId);
    const now = this.clock.now();
    const sub = subs.find((s) => isEntitling(s, this.policy, now));
    if (!sub) throw new AppError('NO_SUBSCRIPTION', 'You have no active subscription.', 422);
    return sub;
  }

  private async plan(accountId: string, targetPriceId: string) {
    const sub = await this.current(accountId);
    if (sub.status === 'past_due')
      throw invalidChange('Update your payment method before changing plans.');
    if (sub.scheduledChangeAction === 'cancel') {
      throw invalidChange('Your subscription is set to cancel. Resume it before changing plans.');
    }
    const [currentPrice, target] = await Promise.all([
      this.uow.repos.catalog.findPriceByPaddleId(sub.priceId),
      this.catalog.sellablePrice(targetPriceId),
    ]);
    if (!currentPrice)
      throw invalidChange('Your current plan can’t be changed online. Contact support.');
    const change: PlanChange = classifyPlanChange(
      { planRank: currentPrice.plan.rank, priceId: sub.priceId },
      { planRank: target.plan.rank, priceId: target.paddlePriceId },
    );
    if (change === 'no_change') throw invalidChange('You are already on that plan.');
    if (target.currency !== currentPrice.currency) {
      throw invalidChange('Switching currency isn’t supported. Contact support.');
    }
    return { sub, change, target };
  }
}
