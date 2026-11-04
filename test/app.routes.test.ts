import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, asWebhook, createHarness, events, PRICES, WEBSITE } from './fakes/harness';

let h: ReturnType<typeof createHarness>;
beforeEach(async () => {
  h = createHarness();
  await h.seedCatalog();
});

/** A browser request from our website (Origin set, as browsers do on POST). */
const fromSite = (cookie: string) => ({ Cookie: cookie, Origin: WEBSITE });
const signed = { 'Paddle-Signature': 'valid', 'Content-Type': 'application/json' };

describe('platform', () => {
  it('health probes and the error envelope', async () => {
    await request(h.app).get('/health/ready').expect(200);
    const res = await request(h.app).get('/v1/nope').expect(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found.', details: [] },
    });
  });

  it('security headers: CSP none, nosniff, no framework banner', async () => {
    const res = await request(h.app).get('/v1/plans');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS only for the website origin, with credentials', async () => {
    const ok = await request(h.app).get('/v1/plans').set('Origin', WEBSITE);
    expect(ok.headers['access-control-allow-origin']).toBe(WEBSITE);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(h.app).get('/v1/plans').set('Origin', 'https://evil.test');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('public pricing', () => {
  it('lists the three plans with prices, modules and the Paddle.js config', async () => {
    const res = await request(h.app).get('/v1/plans').expect(200);
    expect(res.body.data.plans.map((p: { key: string }) => p.key)).toEqual(['basic', 'pro', 'max']);
    expect(res.body.data.checkout).toEqual({ environment: 'sandbox', clientToken: 'test_client' });
  });
});

describe('Google sign-in over HTTP', () => {
  it('start redirects to Google with an httpOnly state cookie scoped to the callback', async () => {
    const res = await request(h.app).get('/v1/auth/google').expect(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.test\/auth/);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^sr_oauth=.+Path=\/v1\/auth\/google.+HttpOnly.+SameSite=Lax/i);
  });

  it('callback sets the session cookie; the account is registered', async () => {
    const { cookie } = await h.signIn('me@example.com');
    const me = await request(h.app).get('/v1/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.data.account).toMatchObject({ email: 'me@example.com', role: 'user' });
  });

  it('a callback without the state cookie fails safely (redirect, no session)', async () => {
    const res = await request(h.app)
      .get('/v1/auth/google/callback')
      .query({ code: 'code:x:x@example.com', state: 'abc' })
      .expect(302);
    expect(res.headers.location).toBe(`${WEBSITE}/login?error=failed`);
    expect(JSON.stringify(res.headers['set-cookie'] ?? [])).not.toContain('sr_session=');
  });

  it('user cancelling on Google returns to the login page', async () => {
    const res = await request(h.app)
      .get('/v1/auth/google/callback')
      .query({ error: 'access_denied' })
      .expect(302);
    expect(res.headers.location).toBe(`${WEBSITE}/login?error=cancelled`);
  });
});

describe('CSRF and caching on cookie routes', () => {
  it('state-changing requests without our Origin are rejected', async () => {
    const { cookie } = await h.signIn('me@example.com');
    const noOrigin = await request(h.app).post('/v1/auth/logout').set('Cookie', cookie).expect(403);
    expect(noOrigin.body.error.code).toBe('CSRF_REJECTED');
    await request(h.app)
      .post('/v1/auth/logout')
      .set({ Cookie: cookie, Origin: 'https://evil.test' })
      .expect(403);
    await request(h.app).post('/v1/auth/logout').set(fromSite(cookie)).expect(204);
  });

  it('authenticated responses are never cached', async () => {
    const { cookie } = await h.signIn('me@example.com');
    const res = await request(h.app).get('/v1/account').set('Cookie', cookie).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('the end-to-end subscriber flow', () => {
  it('register → locked → coupon checkout → subscribed → app unlocks → upgrade', async () => {
    const { cookie, account } = await h.signIn('buyer@example.com');

    const before = await request(h.app).get('/v1/account').set('Cookie', cookie).expect(200);
    expect(before.body.data.plan).toBeNull(); // nothing unlocked yet

    await h.coupons.create(
      { accountId: 'admin', ip: null },
      {
        code: 'LAUNCH30',
        description: 'Launch',
        type: 'percentage',
        amount: 30,
        currency: null,
        recurring: false,
        maxRecurringIntervals: null,
        usageLimit: null,
        expiresAt: null,
        planIds: [],
      },
    );
    const preview = await request(h.app)
      .post('/v1/billing/coupons/preview')
      .set(fromSite(cookie))
      .send({ priceId: PRICES.proMonthly, code: 'launch30' })
      .expect(200);
    expect(preview.body.data).toMatchObject({ code: 'LAUNCH30', amount: '30' });
    const checkout = await request(h.app)
      .post('/v1/billing/checkout')
      .set(fromSite(cookie))
      .send({ priceId: PRICES.proMonthly, couponCode: 'launch30' })
      .expect(201);
    expect(checkout.body.data.transactionId).toMatch(/^txn_/);

    await h.subscribe(account.id); // Paddle confirms the purchase
    const after = await request(h.app).get('/v1/account').set('Cookie', cookie).expect(200);
    expect(after.body.data.plan).toMatchObject({ key: 'pro' });

    const key = h.uow.outboxOf('email.license_issued')[0]!.licenseKey;
    const act = await request(h.app)
      .post('/v1/licenses/activate')
      .send({
        licenseKey: key,
        deviceId: 'a1b2c3d4e5f6a7b8',
        deviceName: 'MacBook Pro',
        appVersion: '0.2.0',
      })
      .expect(200);
    expect(act.body.data).toMatchObject({ plan: 'pro', modules: ['homebrew', 'ports', 'remote'] });

    const up = await request(h.app)
      .post('/v1/billing/subscription/change/preview')
      .set(fromSite(cookie))
      .send({ priceId: PRICES.maxMonthly })
      .expect(200);
    expect(up.body.data).toMatchObject({ change: 'upgrade', dueNow: { amount: '1000' } });
    await request(h.app)
      .post('/v1/billing/subscription/change')
      .set(fromSite(cookie))
      .send({ priceId: PRICES.maxMonthly })
      .expect(200);
  });

  it('checkout requires sign-in and validates the price id shape', async () => {
    await request(h.app)
      .post('/v1/billing/checkout')
      .set('Origin', WEBSITE)
      .send({ priceId: PRICES.proMonthly })
      .expect(401);
    const { cookie } = await h.signIn('me@example.com');
    const bad = await request(h.app)
      .post('/v1/billing/checkout')
      .set(fromSite(cookie))
      .send({ priceId: 'free-please' })
      .expect(400);
    expect(bad.body.error.details[0]).toMatchObject({ path: 'priceId' });
  });
});

describe('admin API', () => {
  it('requires the admin role (401 signed out, 403 for users)', async () => {
    await request(h.app).get('/v1/admin/stats').expect(401);
    const { cookie } = await h.signIn('user@example.com');
    await request(h.app).get('/v1/admin/stats').set('Cookie', cookie).expect(403);
  });

  it('requires a recent sign-in for admin actions', async () => {
    const { cookie } = await h.signIn(ADMIN_EMAIL);
    await request(h.app).get('/v1/admin/stats').set('Cookie', cookie).expect(200);
    h.clock.advanceHours(13);
    const res = await request(h.app).get('/v1/admin/stats').set('Cookie', cookie).expect(401);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('creates a coupon; the action is audited with who did it', async () => {
    const { cookie, account } = await h.signIn(ADMIN_EMAIL);
    const created = await request(h.app)
      .post('/v1/admin/coupons')
      .set(fromSite(cookie))
      .send({
        code: 'BLACKFRIDAY',
        description: 'BF',
        type: 'percentage',
        amount: 40,
        expiresAt: '2026-12-01T00:00:00Z',
      })
      .expect(201);
    expect(created.body.data).toMatchObject({ code: 'BLACKFRIDAY', type: 'percentage' });
    const log = await request(h.app).get('/v1/admin/audit-log').set('Cookie', cookie).expect(200);
    expect(log.body.data[0]).toMatchObject({ action: 'coupon.create', actorId: account.id });
    expect(log.body.meta).toMatchObject({ page: 1, total: 1 });
  });

  it('rejects unknown fields and unknown modules in admin input', async () => {
    const { cookie } = await h.signIn(ADMIN_EMAIL);
    const plan = { key: 'team', name: 'Team', rank: 4, modules: ['homebrew'] };
    await request(h.app)
      .post('/v1/admin/plans')
      .set(fromSite(cookie))
      .send({ ...plan, isAdmin: true })
      .expect(400);
    await request(h.app)
      .post('/v1/admin/plans')
      .set(fromSite(cookie))
      .send({ ...plan, modules: ['not-a-module'] })
      .expect(400);
    await request(h.app).post('/v1/admin/plans').set(fromSite(cookie)).send(plan).expect(201);
  });

  it('lists subscriptions (paginated) and cancels through Paddle', async () => {
    const buyer = await h.uow.repos.accounts.upsertByEmail('buyer@example.com');
    await h.subscribe(buyer.id);
    const { cookie } = await h.signIn(ADMIN_EMAIL);
    const list = await request(h.app)
      .get('/v1/admin/subscriptions')
      .query({ status: 'active', limit: 10 })
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.data[0]).toMatchObject({
      id: 'sub_test0001',
      account: { email: 'buyer@example.com' },
    });
    await request(h.app)
      .post('/v1/admin/subscriptions/sub_test0001/cancel')
      .set(fromSite(cookie))
      .send({ effectiveFrom: 'next_billing_period' })
      .expect(204);
    expect(h.gateway.callsTo('cancel')).toEqual([['sub_test0001', 'next_billing_period']]);
  });

  it('stats: subscribers per plan and MRR', async () => {
    const buyer = await h.uow.repos.accounts.upsertByEmail('buyer@example.com');
    await h.subscribe(buyer.id);
    const { cookie } = await h.signIn(ADMIN_EMAIL);
    const res = await request(h.app).get('/v1/admin/stats').set('Cookie', cookie).expect(200);
    expect(res.body.data).toMatchObject({
      subscriptionsByPlan: { pro: { active: 1 } },
      mrrMinor: { USD: 1500 },
    });
  });

  it('an admin cannot demote themselves; demoting another admin signs them out', async () => {
    const { cookie, account } = await h.signIn(ADMIN_EMAIL);
    await request(h.app)
      .patch(`/v1/admin/accounts/${account.id}/role`)
      .set(fromSite(cookie))
      .send({ role: 'user' })
      .expect(409);

    const other = await h.signIn('second-admin@example.com');
    await h.uow.repos.accounts.setRole(other.account.id, 'admin');
    await request(h.app)
      .patch(`/v1/admin/accounts/${other.account.id}/role`)
      .set(fromSite(cookie))
      .send({ role: 'user' })
      .expect(200);
    await request(h.app).get('/v1/auth/me').set('Cookie', other.cookie).expect(401);
  });
});

describe('paddle webhook', () => {
  it('rejects a missing (400) or bad (401) signature', async () => {
    await request(h.app).post('/v1/webhooks/paddle').send('{}').expect(400);
    await request(h.app)
      .post('/v1/webhooks/paddle')
      .set({ ...signed, 'Paddle-Signature': 'forged' })
      .send('{}')
      .expect(401);
  });

  it('processes a signed event from the raw body', async () => {
    const res = await request(h.app)
      .post('/v1/webhooks/paddle')
      .set(signed)
      .send(asWebhook(events.customer('ctm_1', 'b@example.com')))
      .expect(200);
    expect(res.body.data.outcome).toBe('processed');
  });

  it('with the IP allowlist on, only Paddle IPs get through (and it fails closed)', async () => {
    const allowOnly = (ip: string) => ({ allows: (c: string) => Promise.resolve(c === ip) });
    const body = asWebhook(events.customer('ctm_1', 'b@example.com'));

    const blocked = createHarness({ webhookIps: allowOnly('34.232.58.13') });
    await request(blocked.app).post('/v1/webhooks/paddle').set(signed).send(body).expect(403);

    const down = createHarness({ webhookIps: { allows: () => Promise.reject(new Error('down')) } });
    await request(down.app).post('/v1/webhooks/paddle').set(signed).send(body).expect(403);

    const local = createHarness({ webhookIps: allowOnly('127.0.0.1') });
    await request(local.app).post('/v1/webhooks/paddle').set(signed).send(body).expect(200);
  });
});
