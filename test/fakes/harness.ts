import { generateKeyPairSync } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '@/app';
import { loadEnv } from '@/config/env';
import { buildContainer } from '@/container';
import { LicenseTokenSigner } from '@/domain/licensing/licenseToken';
import type { UnitOfWork } from '@/db/unitOfWork';
import type { IpAllowlist } from '@/integrations/paddle/paddle.ips';
import type { StoreFactory } from '@/middleware/rateLimits';
import type { BillingEvent, SubscriptionSnapshot } from '@/modules/billing/billing.gateway';
import { accountLink } from '@/modules/checkout/checkout.service';
import type { Clock } from '@/shared/clock';
import { Signer } from '@/shared/crypto/signed';
import { FakeGateway } from './fakeGateway';
import { FakeIdentityProvider } from './fakeIdentity';
import { MemoryUnitOfWork } from './memory';

export const WEBSITE = 'https://stackroost.test';
export const ADMIN_EMAIL = 'admin@stackroost.test';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

/** Paddle price ids of the seeded catalogue (rank: basic 1 < pro 2 < max 3). */
export const PRICES = {
  basicMonthly: 'pri_01basicmonthly',
  proMonthly: 'pri_01promonthly00',
  proYearly: 'pri_01proyearly000',
  maxMonthly: 'pri_01maxmonthly00',
} as const;

/** A controllable clock. */
export class TestClock implements Clock {
  constructor(public current = new Date('2026-11-02T12:00:00Z')) {}
  now() {
    return new Date(this.current);
  }
  advanceDays(days: number) {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
  advanceHours(hours: number) {
    this.current = new Date(this.current.getTime() + hours * 3_600_000);
  }
}

/** The real app and services over in-memory infrastructure — no DB, no network. */
/**
 * Options: `uow` swaps the in-memory store for a real one (integration tests);
 * `rateLimitStore` for the Postgres limiter.
 */
export function createHarness(
  opts: { webhookIps?: IpAllowlist; uow?: UnitOfWork; rateLimitStore?: StoreFactory } = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused@localhost/unused',
    API_URL: 'https://api.stackroost.test',
    WEBSITE_URL: WEBSITE,
    SESSION_SECRET,
    ADMIN_EMAILS: ADMIN_EMAIL,
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    PADDLE_API_KEY: 'test',
    PADDLE_WEBHOOK_SECRET: 'test',
    PADDLE_CLIENT_TOKEN: 'test_client',
    LICENSE_SIGNING_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    LICENSE_SIGNING_PUBLIC_KEY: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    LICENSE_MAX_DEVICES: '2',
  });
  const clock = new TestClock();
  const uow = new MemoryUnitOfWork(() => clock.now());
  const store: UnitOfWork = opts.uow ?? uow;
  const gateway = new FakeGateway();
  const identity = new FakeIdentityProvider();
  const container = buildContainer(env, {
    uow: store,
    gateway,
    identity,
    mailer: { send: () => Promise.resolve() },
    signer: new LicenseTokenSigner(
      env.LICENSE_SIGNING_PRIVATE_KEY,
      env.LICENSE_SIGNING_PUBLIC_KEY,
      'k1',
    ),
    webhookIps: opts.webhookIps ?? null,
    rateLimitStore: opts.rateLimitStore ?? (() => undefined),
    clock,
    log: pino({ level: 'silent' }),
    prisma: null,
    checkDatabase: () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
  const app = createApp(container);
  const hmac = new Signer(SESSION_SECRET);

  /** Seeds Basic / Pro / Max with prices, as the seed script + admin would. */
  async function seedCatalog() {
    const plan = (key: string, rank: number, modules: string[], features: string[] = []) =>
      store.repos.catalog.createPlan({
        key,
        name: key.toUpperCase(),
        description: '',
        rank,
        modules,
        features,
      });
    const plans = {
      basic: await plan('basic', 1, ['homebrew', 'ports']),
      pro: await plan('pro', 2, ['homebrew', 'ports', 'remote']),
      max: await plan('max', 3, ['homebrew', 'ports', 'remote', 'kafka'], ['maclean.deep_scan']),
    };
    const price = (
      planId: string,
      paddlePriceId: string,
      interval: 'month' | 'year',
      amountMinor: number,
    ) =>
      store.repos.catalog.createPrice({
        planId,
        paddlePriceId,
        interval,
        amountMinor,
        currency: 'USD',
      });
    await price(plans.basic.id, PRICES.basicMonthly, 'month', 500);
    await price(plans.pro.id, PRICES.proMonthly, 'month', 1500);
    await price(plans.pro.id, PRICES.proYearly, 'year', 15000);
    await price(plans.max.id, PRICES.maxMonthly, 'month', 3000);
    return plans;
  }

  /** Full Google sign-in over HTTP; returns the session cookie and account. */
  async function signIn(email: string, sub = email) {
    const start = await request(app).get('/v1/auth/google').query({ returnTo: '/pricing' });
    const cookies = start.headers['set-cookie'] as unknown as string[];
    const stateCookie = cookies.find((c) => c.startsWith('sr_oauth='))!.split(';')[0]!;
    const done = await request(app)
      .get('/v1/auth/google/callback')
      .set('Cookie', stateCookie)
      .query({ code: `code:${sub}:${email}`, state: identity.lastAuthorization!.state });
    const session = (done.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) =>
      c.startsWith('sr_session='),
    );
    if (!session) throw new Error(`sign-in failed: ${String(done.headers.location)}`);
    const account = (await store.repos.accounts.findByEmail(email))!;
    return { cookie: session.split(';')[0]!, account };
  }

  /** Delivers a webhook through the real service. */
  const deliver = (e: BillingEvent) =>
    container.services.billing.handleWebhook(JSON.stringify(e), 'valid');

  /** A completed checkout: subscription webhook carrying the signed account link. */
  const subscribe = (accountId: string, over: Partial<SubscriptionSnapshot> = {}, at?: string) => {
    const link = accountLink(hmac, accountId);
    return deliver(
      events.subscription({ accountId: link.accountId, accountSig: link.accountSig, ...over }, at),
    );
  };

  return {
    env,
    uow,
    gateway,
    identity,
    clock,
    container,
    app,
    hmac,
    seedCatalog,
    signIn,
    deliver,
    subscribe,
    ...container.services,
  };
}

let seq = 0;
const base = (eventType: string, occurredAt: string) => ({
  eventId: `evt_${String(++seq)}`,
  eventType,
  occurredAt: new Date(occurredAt),
});

/** Builders for webhook payloads (serialised and fed to FakeGateway). */
export const events = {
  customer: (id: string, email: string, at = '2026-11-02T10:00:00Z'): BillingEvent => ({
    ...base('customer.created', at),
    kind: 'customer',
    customer: { id, email },
  }),
  subscription: (
    over: Partial<SubscriptionSnapshot> = {},
    at = '2026-11-02T10:00:01Z',
    eventType = 'subscription.updated',
  ): BillingEvent => ({
    ...base(eventType, at),
    kind: 'subscription',
    subscription: {
      id: 'sub_test0001',
      customerId: 'ctm_1',
      status: 'active',
      priceId: PRICES.proMonthly,
      productId: 'pro_x',
      currentPeriodEndsAt: new Date('2026-12-02T00:00:00Z'),
      scheduledChange: null,
      accountId: null,
      accountSig: null,
      ...over,
    },
  }),
};

export const asWebhook = (e: BillingEvent) => JSON.stringify(e);
