import type { PrismaClient } from '@/generated/prisma/client';
import type { Env } from '@/config/env';
import { createPrisma } from '@/db/prisma';
import { PrismaUnitOfWork, type UnitOfWork } from '@/db/unitOfWork';
import { LicenseTokenSigner } from '@/domain/licensing/licenseToken';
import { GoogleIdentityProvider } from '@/integrations/google/google.identity';
import { LogMailer, type Mailer } from '@/integrations/mailer/mailer';
import { PaddleGateway } from '@/integrations/paddle/paddle.gateway';
import { PaddleIpAllowlist, type IpAllowlist } from '@/integrations/paddle/paddle.ips';
import { requireAdmin, requireSession, sessionCookieName } from '@/middleware/auth';
import { PostgresRateLimitStore } from '@/middleware/rateLimit.store';
import { createRateLimits, type StoreFactory } from '@/middleware/rateLimits';
import { AccountController } from '@/modules/account/account.controller';
import { AccountService } from '@/modules/account/account.service';
import { AccountsService } from '@/modules/accounts/accounts.service';
import { AdminController } from '@/modules/admin/admin.controller';
import { AdminAccountsService } from '@/modules/admin/adminAccounts.service';
import { AdminInsightsService } from '@/modules/admin/adminInsights.service';
import { AdminSubscriptionsService } from '@/modules/admin/adminSubscriptions.service';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthController } from '@/modules/auth/auth.controller';
import { AuthService } from '@/modules/auth/auth.service';
import type { IdentityProvider } from '@/modules/auth/identity.provider';
import { BillingController } from '@/modules/billing/billing.controller';
import type { BillingGateway, CatalogGateway } from '@/modules/billing/billing.gateway';
import { BillingService } from '@/modules/billing/billing.service';
import { EntitlementsService } from '@/modules/billing/entitlements.service';
import { SubscriptionsService } from '@/modules/billing/subscriptions.service';
import { CatalogService } from '@/modules/catalog/catalog.service';
import { CheckoutService } from '@/modules/checkout/checkout.service';
import { CouponsService } from '@/modules/coupons/coupons.service';
import { LicensesController } from '@/modules/licenses/licenses.controller';
import { LicensesService } from '@/modules/licenses/licenses.service';
import { systemClock, type Clock } from '@/shared/clock';
import { Signer } from '@/shared/crypto/signed';
import { createLogger, type Logger } from '@/shared/logger';

/** Infrastructure the services depend on — swapped wholesale in tests. */
export interface Infrastructure {
  uow: UnitOfWork;
  gateway: BillingGateway & CatalogGateway;
  identity: IdentityProvider;
  mailer: Mailer;
  signer: LicenseTokenSigner;
  webhookIps: IpAllowlist | null;
  rateLimitStore: StoreFactory;
  clock: Clock;
  log: Logger;
  prisma: PrismaClient | null;
  checkDatabase: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Composition root: the only place that knows concrete classes. Everything
 * else receives interfaces through constructors (explicit, type-checked DI).
 */
export function buildContainer(env: Env, infra: Infrastructure) {
  const { uow, gateway, signer, clock, log } = infra;
  const secureCookies = env.NODE_ENV === 'production';
  const hmac = new Signer(env.SESSION_SECRET);
  const policy = { pastDueGraceDays: env.PAST_DUE_GRACE_DAYS };

  const audit = new AuditService(uow);
  const accounts = new AccountsService();
  const entitlements = new EntitlementsService(policy, clock);
  const licenses = new LicensesService(uow, entitlements, signer, clock, {
    tokenTtlDays: env.LICENSE_TOKEN_TTL_DAYS,
    maxDevices: env.LICENSE_MAX_DEVICES,
    refreshWindowDays: 30,
  });
  const catalog = new CatalogService(uow, gateway, audit, {
    environment: env.PADDLE_ENV,
    clientToken: env.PADDLE_CLIENT_TOKEN,
  });
  const coupons = new CouponsService(uow, gateway, audit, clock);
  const billing = new BillingService(uow, gateway, accounts, licenses, entitlements, hmac, log);
  const subscriptions = new SubscriptionsService(
    uow,
    gateway,
    catalog,
    policy,
    clock,
    log,
    env.DOWNGRADE_APPLY_LEAD_MINUTES,
  );
  const checkout = new CheckoutService(uow, gateway, catalog, coupons, entitlements, hmac);
  const auth = new AuthService(uow, infra.identity, hmac, clock, {
    sessionTtlDays: env.SESSION_TTL_DAYS,
    sessionIdleDays: env.SESSION_IDLE_DAYS,
    adminEmails: env.ADMIN_EMAILS,
  });

  const cookieName = sessionCookieName(secureCookies);
  return {
    env,
    infra,
    services: { auth, billing, subscriptions, checkout, catalog, coupons, licenses },
    limits: createRateLimits(infra.rateLimitStore),
    guards: {
      session: requireSession(auth, cookieName),
      admin: requireAdmin(clock, env.ADMIN_RECENT_AUTH_HOURS),
    },
    controllers: {
      auth: new AuthController(auth, env.WEBSITE_URL, cookieName, secureCookies),
      account: new AccountController(new AccountService(uow, billing, licenses)),
      billing: new BillingController(billing, checkout, subscriptions),
      licenses: new LicensesController(licenses),
      admin: new AdminController(
        new AdminAccountsService(uow, billing, licenses, auth, audit),
        new AdminSubscriptionsService(uow, gateway, audit),
        new AdminInsightsService(uow),
        catalog,
        coupons,
        audit,
      ),
    },
  };
}

export type Container = ReturnType<typeof buildContainer>;

/** Production/development infrastructure from validated env. */
export function createInfrastructure(env: Env): Infrastructure {
  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
  const prisma = createPrisma(env.DATABASE_URL);
  return {
    uow: new PrismaUnitOfWork(prisma),
    gateway: new PaddleGateway(env.PADDLE_API_KEY, env.PADDLE_ENV, env.PADDLE_WEBHOOK_SECRET),
    identity: new GoogleIdentityProvider(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      new URL('/v1/auth/google/callback', env.API_URL).toString(),
    ),
    // TODO(production): replace with a provider adapter (Resend/Postmark/SES) implementing Mailer.
    mailer: new LogMailer(log),
    signer: new LicenseTokenSigner(
      env.LICENSE_SIGNING_PRIVATE_KEY,
      env.LICENSE_SIGNING_PUBLIC_KEY,
      env.LICENSE_SIGNING_KEY_ID,
    ),
    webhookIps: env.PADDLE_WEBHOOK_IP_ALLOWLIST ? new PaddleIpAllowlist(env.PADDLE_ENV) : null,
    rateLimitStore: (prefix) => new PostgresRateLimitStore(prisma, prefix),
    clock: systemClock,
    log,
    prisma,
    checkDatabase: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
    close: () => prisma.$disconnect(),
  };
}
