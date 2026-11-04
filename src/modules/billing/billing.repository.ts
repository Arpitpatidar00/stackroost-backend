import type {
  Account,
  Customer,
  Subscription,
  SubscriptionStatus,
} from '@/generated/prisma/client';
import { isUniqueViolation, type DbClient } from '@/db/prisma';
import { skipTake, type Page, type PageRequest } from '@/shared/http/pagination';

export type SubscriptionWithAccount = Subscription & {
  customer: Customer & { account: Account | null };
};

export interface CustomerUpsert {
  id: string;
  email?: string | null;
  accountId?: string | null;
}

export interface SubscriptionUpsert {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  priceId: string;
  productId: string;
  currentPeriodEndsAt: Date | null;
  scheduledChangeAction: string | null;
  scheduledChangeAt: Date | null;
  lastEventAt: Date;
}

export interface CustomersRepository {
  findById(id: string): Promise<Customer | null>;
  /** Only provided fields are written; absent ones keep their stored value. */
  upsert(data: CustomerUpsert): Promise<Customer>;
  listByAccount(accountId: string): Promise<Customer[]>;
}

export interface SubscriptionsRepository {
  /**
   * Convergent write: applies `data` unless the stored row came from a newer
   * event (webhooks are unordered). Returns whether it wrote.
   */
  upsertIfNewer(data: SubscriptionUpsert): Promise<boolean>;
  listByAccount(accountId: string): Promise<Subscription[]>;
  findById(id: string): Promise<SubscriptionWithAccount | null>;
  /** Records (or clears, with null) a downgrade to apply at period end. */
  setPending(id: string, priceId: string | null, now: Date): Promise<void>;
  /** Active subscriptions with a pending downgrade whose period ends before `before`. */
  dueDowngrades(before: Date): Promise<Subscription[]>;
  /** Pending downgrade sent to Paddle: keep the old price entitled until the period ends. */
  markDowngradeApplied(id: string, graceFromPriceId: string, graceUntil: Date): Promise<void>;
  adminList(
    filter: { status?: SubscriptionStatus; search?: string },
    page: PageRequest,
  ): Promise<Page<SubscriptionWithAccount>>;
  countByStatusAndPrice(): Promise<
    { status: SubscriptionStatus; priceId: string; count: number }[]
  >;
}

export interface WebhookEventsRepository {
  /** Records the event id; false if it was already processed (dedup ledger). */
  tryRecord(event: { id: string; eventType: string; occurredAt: Date }): Promise<boolean>;
}

export class PrismaCustomersRepository implements CustomersRepository {
  constructor(private readonly db: DbClient) {}

  findById(id: string) {
    return this.db.customer.findUnique({ where: { id } });
  }

  upsert({ id, email, accountId }: CustomerUpsert) {
    const fields = {
      ...(email !== undefined && { email }),
      ...(accountId !== undefined && { accountId }),
    };
    return this.db.customer.upsert({ where: { id }, create: { id, ...fields }, update: fields });
  }

  listByAccount(accountId: string) {
    return this.db.customer.findMany({ where: { accountId } });
  }
}

export class PrismaSubscriptionsRepository implements SubscriptionsRepository {
  constructor(private readonly db: DbClient) {}

  async upsertIfNewer(data: SubscriptionUpsert) {
    const existing = await this.db.subscription.findUnique({
      where: { id: data.id },
      select: { lastEventAt: true },
    });
    if (existing && existing.lastEventAt > data.lastEventAt) return false;
    await this.db.subscription.upsert({ where: { id: data.id }, create: data, update: data });
    return true;
  }

  listByAccount(accountId: string) {
    return this.db.subscription.findMany({
      where: { customer: { accountId } },
      orderBy: { createdAt: 'desc' },
    });
  }

  findById(id: string) {
    return this.db.subscription.findUnique({
      where: { id },
      include: { customer: { include: { account: true } } },
    });
  }

  async setPending(id: string, priceId: string | null, now: Date) {
    await this.db.subscription.update({
      where: { id },
      data: { pendingPriceId: priceId, pendingRequestedAt: priceId ? now : null },
    });
  }

  dueDowngrades(before: Date) {
    return this.db.subscription.findMany({
      where: {
        pendingPriceId: { not: null },
        status: 'active',
        currentPeriodEndsAt: { lte: before },
      },
    });
  }

  async markDowngradeApplied(id: string, graceFromPriceId: string, graceUntil: Date) {
    await this.db.subscription.update({
      where: { id },
      data: { pendingPriceId: null, pendingRequestedAt: null, graceFromPriceId, graceUntil },
    });
  }

  async adminList(filter: { status?: SubscriptionStatus; search?: string }, page: PageRequest) {
    const where = {
      ...(filter.status && { status: filter.status }),
      ...(filter.search && {
        customer: {
          OR: [
            { email: { contains: filter.search, mode: 'insensitive' as const } },
            { account: { email: { contains: filter.search, mode: 'insensitive' as const } } },
          ],
        },
      }),
    };
    const [items, total] = await Promise.all([
      this.db.subscription.findMany({
        where,
        include: { customer: { include: { account: true } } },
        orderBy: { updatedAt: 'desc' },
        ...skipTake(page),
      }),
      this.db.subscription.count({ where }),
    ]);
    return { items, total };
  }

  async countByStatusAndPrice() {
    const rows = await this.db.subscription.groupBy({
      by: ['status', 'priceId'],
      _count: { _all: true },
    });
    return rows.map((r) => ({ status: r.status, priceId: r.priceId, count: r._count._all }));
  }
}

export class PrismaWebhookEventsRepository implements WebhookEventsRepository {
  constructor(private readonly db: DbClient) {}

  async tryRecord(event: { id: string; eventType: string; occurredAt: Date }) {
    try {
      await this.db.webhookEvent.create({ data: event });
      return true;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }
}
