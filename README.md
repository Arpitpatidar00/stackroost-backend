# Stackroost Backend

Accounts, subscriptions, licensing and the admin API for **Stackroost** (macOS app) and its website.

**The product flow**

1. **Register / sign in with Google** on the website (OpenID Connect, code + PKCE).
2. Nothing is unlocked yet — the pricing page shows **Basic / Pro / Max** (admin-managed).
3. **Subscribe** through Paddle checkout, optionally with an **admin-created coupon**.
4. Paddle confirms → a **license key** is emailed → the app activates and unlocks exactly the
   plan's modules (signed Ed25519 token, verified offline).
5. **Upgrade** any time: pay only the prorated difference, unlocked immediately.
   **Downgrade**: scheduled for the end of the paid period.
6. **Admins** manage plans, prices, coupons, subscriptions and accounts through `/v1/admin`
   (every action audited). The admin panel UI comes later; the API is complete.

## Quick start

```bash
nvm use                        # Node 22
npm install
cp .env.example .env           # fill Google OAuth + Paddle sandbox values, SESSION_SECRET
npm run keys:generate >> .env  # Ed25519 license-signing keypair (replace the empty lines)
docker compose up -d db        # Postgres 16 on :5432
npm run db:deploy              # apply migrations (db:migrate when you change the schema)
npm run seed:plans             # Basic / Pro / Max (prices are created via the admin API)
npm run dev                    # API on :4000
npm run worker                 # emails, scheduled downgrades, housekeeping (separate terminal)
```

`npm run check` = typecheck + lint + format + unit tests (no database needed).
`DATABASE_URL_TEST=… npm run test:integration` runs the same flows on real Postgres.

## Architecture

Modular monolith, one request path, dependencies point inward:

```
route → guards (session, admin, CSRF, rate limit) → validate(zod) → controller → service → repository → Postgres
                                                                         ↘ ports: BillingGateway / CatalogGateway (Paddle),
                                                                                  IdentityProvider (Google), Mailer
```

| Path                  | What lives there                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `src/config/env.ts`   | The only reader of `process.env`; validated at boot; refuses insecure production config.     |
| `src/container.ts`    | Composition root — the only place concrete classes are wired.                                |
| `src/domain/`         | Pure rules: entitlements (plan resolution, grace), plan changes, coupons, license key/token. |
| `src/modules/<name>/` | `routes → controller → service → repository` + `validation`.                                 |
| `src/integrations/`   | Adapters: Paddle SDK, Paddle IP allowlist, Google OIDC, mail.                                |
| `src/jobs/`           | Transactional outbox + worker scheduler (downgrades, purges).                                |
| `test/`               | Fakes (in-memory UoW with rollback, Paddle, Google), harness, HTTP + Postgres suites.        |

Patterns: Repository · Unit of Work · Ports & Adapters (+ anti-corruption mapper) · Strategy
registry (webhooks) · Transactional Outbox · Composition Root / constructor DI · BFF (`account`).

## API (v1)

| Method | Path                                                               | Auth                   | Purpose                                                   |
| ------ | ------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------- |
| GET    | `/health/live`, `/health/ready`                                    | —                      | Liveness / readiness.                                     |
| GET    | `/v1/plans`                                                        | public                 | Plans, modules, prices, Paddle.js config.                 |
| GET    | `/v1/auth/google` → `/v1/auth/google/callback`                     | public                 | Register / sign in (redirect flow).                       |
| GET    | `/v1/auth/me` · POST `/logout` · `/logout-all`                     | session                | Current user / sign out.                                  |
| GET    | `/v1/account`                                                      | session                | Plan, subscription, license preview, devices.             |
| DELETE | `/v1/account/devices/:id` · POST `/license/rotate`                 | session                | Seats / leaked key.                                       |
| POST   | `/v1/billing/checkout`                                             | session                | `{priceId, couponCode?}` → `transactionId` for Paddle.js. |
| POST   | `/v1/billing/coupons/preview`                                      | session                | Validate a coupon for a plan.                             |
| POST   | `/v1/billing/subscription/change/preview` · `/change`              | session                | Upgrade (prorated now) / downgrade (at renewal).          |
| DELETE | `/v1/billing/subscription/change`                                  | session                | Cancel a scheduled downgrade.                             |
| POST   | `/v1/billing/portal`                                               | session                | Paddle customer portal URL.                               |
| POST   | `/v1/licenses/activate` · `/refresh` · `/deactivate` · GET `/keys` | key / token            | Desktop app.                                              |
| POST   | `/v1/webhooks/paddle`                                              | Paddle IPs + signature | Webhooks.                                                 |
| *      | `/v1/admin/...`                                                    | admin + recent sign-in | See below.                                                |

**Admin** (`/v1/admin`): `GET stats` · `GET/PATCH accounts[/:id][/role]` ·
`POST accounts/:id/license/{revoke,restore}` · `POST accounts/:id/sessions/revoke` ·
`GET/POST plans`, `PATCH plans/:id`, `POST plans/:id/prices`, `PATCH prices/:id` ·
`GET/POST coupons`, `PATCH coupons/:id` · `GET subscriptions[/:id]`,
`POST subscriptions/:id/{cancel,pause,resume}` · `GET audit-log`. Lists are paginated
(`page`, `limit` ≤ 100, `meta` in the response).

Envelope: `{ "success": true, "data", "meta"? }` / `{ "success": false, "error": { "code", "message", "details" } }`.

See [docs/INTEGRATION.md](docs/INTEGRATION.md) (website + app contracts) and
[docs/SECURITY.md](docs/SECURITY.md) (controls + production checklist).

## Deploying

One image, two processes: `node dist/server.js` (API) and `node dist/worker.js` (worker).
Release step: `npx prisma migrate deploy`. Behind a load balancer: `TRUST_PROXY_HOPS=1`.
Before launch: a real `Mailer` adapter (TODO in `src/container.ts`) — see the security checklist.

## Tooling note

`vitest` is pinned to 4.0.x: npm 10.9 crashes resolving 4.1's optional peers (`edgesOut`).
The open advisory affects only Vitest's UI server, which isn't used. Bump when npm is fixed.
