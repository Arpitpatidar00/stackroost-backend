import type { Repositories, UnitOfWork } from '@/db/unitOfWork';
import type { AccountsService } from '@/modules/accounts/accounts.service';
import { verifyAccountLink } from '@/modules/checkout/checkout.service';
import type { LicensesService } from '@/modules/licenses/licenses.service';
import type { Signer } from '@/shared/crypto/signed';
import { AppError } from '@/shared/errors/AppError';
import type { Logger } from '@/shared/logger';
import type { BillingEvent, BillingGateway } from './billing.gateway';
import type { EntitlementsService } from './entitlements.service';

type Handled<K extends BillingEvent['kind']> = Extract<BillingEvent, { kind: K }>;

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

/**
 * Paddle → our mirror. Delivery is at-least-once and unordered, so:
 * - every event is recorded in a ledger (event id) inside the same
 *   transaction as its effects → duplicates are no-ops, including emails;
 * - subscription writes are convergent (older events never win);
 * - purchases link to accounts by the signed checkout custom data, else by
 *   the customer's email — never by an unsigned, client-supplied id.
 */
export class BillingService {
  /** Strategy registry: one handler per event kind. */
  private readonly handlers: {
    [K in Exclude<BillingEvent['kind'], 'ignored'>]: (
      tx: Repositories,
      event: Handled<K>,
    ) => Promise<void>;
  } = {
    customer: (tx, e) => this.onCustomer(tx, e),
    subscription: (tx, e) => this.onSubscription(tx, e),
  };

  constructor(
    private readonly uow: UnitOfWork,
    private readonly gateway: BillingGateway,
    private readonly accounts: AccountsService,
    private readonly licenses: LicensesService,
    private readonly entitlements: EntitlementsService,
    private readonly signer: Signer,
    private readonly log: Logger,
  ) {}

  async handleWebhook(rawBody: string, signature: string): Promise<WebhookOutcome> {
    let event: BillingEvent;
    try {
      event = await this.gateway.parseWebhook(rawBody, signature);
    } catch {
      // Tampered, wrong/rotated secret or stale: indistinguishable. Non-2xx → Paddle retries.
      throw new AppError('WEBHOOK_REJECTED', 'Webhook signature verification failed.', 401);
    }
    if (event.kind === 'ignored') return 'ignored';

    return this.uow.transaction(async (tx) => {
      const fresh = await tx.webhookEvents.tryRecord({
        id: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
      });
      if (!fresh) return 'duplicate';
      await (this.handlers[event.kind] as (tx: Repositories, e: BillingEvent) => Promise<void>)(
        tx,
        event,
      );
      this.log.info(
        { eventId: event.eventId, eventType: event.eventType },
        'paddle event processed',
      );
      return 'processed';
    });
  }

  /** Paddle-hosted portal: invoices, payment method, cancellation. */
  async portalUrl(accountId: string): Promise<string> {
    const [customer] = await this.uow.repos.customers.listByAccount(accountId);
    if (!customer) throw new AppError('NO_SUBSCRIPTION', 'Subscribe first to manage billing.', 422);
    const subs = await this.uow.repos.subscriptions.listByAccount(accountId);
    return this.gateway.createPortalUrl(
      customer.id,
      subs.filter((s) => s.customerId === customer.id && s.status !== 'canceled').map((s) => s.id),
    );
  }

  /** Subscription state for the website (from the mirror, no API call). */
  async summary(repos: Repositories, accountId: string) {
    const [plan, subs] = await Promise.all([
      this.entitlements.planFor(repos, accountId),
      repos.subscriptions.listByAccount(accountId),
    ]);
    const current = subs.find((s) => s.status !== 'canceled') ?? subs[0] ?? null;
    const pending = current?.pendingPriceId
      ? await repos.catalog.findPriceByPaddleId(current.pendingPriceId)
      : null;
    return {
      plan: plan && {
        key: plan.key,
        name: plan.name,
        modules: plan.modules,
        features: plan.features,
      },
      subscription: current && {
        id: current.id,
        status: current.status,
        priceId: current.priceId,
        currentPeriodEndsAt: current.currentPeriodEndsAt?.toISOString() ?? null,
        scheduledChange: current.scheduledChangeAction
          ? {
              action: current.scheduledChangeAction,
              effectiveAt: current.scheduledChangeAt?.toISOString() ?? null,
            }
          : null,
        pendingPlanChange: pending && {
          plan: pending.plan.key,
          priceId: pending.paddlePriceId,
          effectiveAt: current.currentPeriodEndsAt?.toISOString() ?? null,
        },
        /** Show "update your payment method" while Paddle retries the card. */
        paymentFailing: current.status === 'past_due',
      },
    };
  }

  private async onCustomer(tx: Repositories, { customer }: Handled<'customer'>) {
    const existing = await tx.customers.findById(customer.id);
    // Already bound to an account at checkout → keep that link; just mirror the email.
    if (existing?.accountId) {
      await tx.customers.upsert({ id: customer.id, email: customer.email });
      await this.grantIfEntitled(tx, existing.accountId);
      return;
    }
    const account = await this.accounts.findOrCreateByEmail(tx, customer.email);
    await tx.customers.upsert({ id: customer.id, email: account.email, accountId: account.id });
    await this.grantIfEntitled(tx, account.id);
  }

  private async onSubscription(
    tx: Repositories,
    { subscription: s, occurredAt }: Handled<'subscription'>,
  ) {
    const customer =
      (await tx.customers.findById(s.customerId)) ??
      (await tx.customers.upsert({ id: s.customerId }));

    await tx.subscriptions.upsertIfNewer({
      id: s.id,
      customerId: s.customerId,
      status: s.status,
      priceId: s.priceId,
      productId: s.productId,
      currentPeriodEndsAt: s.currentPeriodEndsAt,
      scheduledChangeAction: s.scheduledChange?.action ?? null,
      scheduledChangeAt: s.scheduledChange?.effectiveAt ?? null,
      lastEventAt: occurredAt,
    });

    let accountId = customer.accountId;
    if (
      !accountId &&
      s.accountId &&
      s.accountSig &&
      verifyAccountLink(this.signer, s.accountId, s.accountSig)
    ) {
      const linked = await tx.accounts.findById(s.accountId);
      if (linked) {
        await tx.customers.upsert({ id: customer.id, accountId: linked.id });
        accountId = linked.id;
      }
    }
    if (accountId) await this.grantIfEntitled(tx, accountId);
  }

  private async grantIfEntitled(tx: Repositories, accountId: string) {
    const account = await tx.accounts.findById(accountId);
    if (account && (await this.entitlements.planFor(tx, accountId))) {
      await this.licenses.ensureIssued(tx, account.id, account.email);
    }
  }
}
