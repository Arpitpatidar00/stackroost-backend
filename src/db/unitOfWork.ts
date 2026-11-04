import type { PrismaClient } from '@/generated/prisma/client';
import type { DbClient } from './prisma';
import {
  PrismaAccountsRepository,
  type AccountsRepository,
} from '@/modules/accounts/accounts.repository';
import { PrismaAuditRepository, type AuditRepository } from '@/modules/audit/audit.repository';
import { PrismaAuthRepository, type AuthRepository } from '@/modules/auth/auth.repository';
import {
  PrismaCustomersRepository,
  PrismaSubscriptionsRepository,
  PrismaWebhookEventsRepository,
  type CustomersRepository,
  type SubscriptionsRepository,
  type WebhookEventsRepository,
} from '@/modules/billing/billing.repository';
import {
  PrismaCatalogRepository,
  type CatalogRepository,
} from '@/modules/catalog/catalog.repository';
import {
  PrismaCouponsRepository,
  type CouponsRepository,
} from '@/modules/coupons/coupons.repository';
import {
  PrismaActivationsRepository,
  PrismaLicensesRepository,
  type ActivationsRepository,
  type LicensesRepository,
} from '@/modules/licenses/licenses.repository';
import { PrismaOutboxRepository, type OutboxRepository } from '@/jobs/outbox.repository';

/** Every repository, bound to one client (root or transaction). */
export interface Repositories {
  accounts: AccountsRepository;
  auth: AuthRepository;
  audit: AuditRepository;
  catalog: CatalogRepository;
  coupons: CouponsRepository;
  customers: CustomersRepository;
  subscriptions: SubscriptionsRepository;
  webhookEvents: WebhookEventsRepository;
  licenses: LicensesRepository;
  activations: ActivationsRepository;
  outbox: OutboxRepository;
}

/**
 * Unit of Work: `repos` for single statements, `transaction` for multi-step
 * writes — all-or-nothing, with outbox rows committed alongside the state.
 */
export interface UnitOfWork {
  readonly repos: Repositories;
  transaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T>;
}

export const createRepositories = (db: DbClient): Repositories => ({
  accounts: new PrismaAccountsRepository(db),
  auth: new PrismaAuthRepository(db),
  audit: new PrismaAuditRepository(db),
  catalog: new PrismaCatalogRepository(db),
  coupons: new PrismaCouponsRepository(db),
  customers: new PrismaCustomersRepository(db),
  subscriptions: new PrismaSubscriptionsRepository(db),
  webhookEvents: new PrismaWebhookEventsRepository(db),
  licenses: new PrismaLicensesRepository(db),
  activations: new PrismaActivationsRepository(db),
  outbox: new PrismaOutboxRepository(db),
});

export class PrismaUnitOfWork implements UnitOfWork {
  readonly repos: Repositories;

  constructor(private readonly prisma: PrismaClient) {
    this.repos = createRepositories(prisma);
  }

  transaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(createRepositories(tx)));
  }
}
