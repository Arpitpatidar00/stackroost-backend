# CLAUDE.md — Stackroost Backend engineering guide

Rules, not suggestions. If one blocks a task, stop and say so instead of working around it.
Money, licenses and personal data live here: correctness beats speed on every change.

## Commands

```bash
npm run dev / npm run worker     # API (:4000) / outbox worker
npm run check                    # typecheck + lint + format + tests — run before "done"
npm test                         # vitest; no database needed
npm run test:integration         # same flows on real Postgres (DATABASE_URL_TEST)
npm run seed:plans               # Basic / Pro / Max
npm run db:migrate               # new migration after a schema change (commit it)
npm run keys:generate            # Ed25519 license-signing keypair
```

## Architecture (one path, never skip a layer)

`routes` (path, verb, middleware chain only) → `requireSession`/`publicRoute(...)` → rate limit →
`validate(schemas)` → **controller** (read `input(req, schemas)`, call ONE service method, shape the
envelope) → **service** (business rules, transactions, `AppError`) → **repository** (queries only).

- Every route makes an explicit access decision: `requireSession` or `publicRoute('why')`.
- Services never see `req`/`res`; they must be callable from a script, worker or test.
- A module uses another module only through its **service**; never another module's repository.
- Concrete classes are constructed **only** in `src/container.ts`.
- `process.env` is read **only** in `src/config/env.ts` (ESLint enforces it).
- Third parties sit behind a port (`BillingGateway`, `Mailer`); SDK types never leave `integrations/`.

## Auth & admin

- Website sign-in is **Google only** (`modules/auth`, OIDC code + PKCE + state + nonce). Never add
  passwords or another login without a design review.
- Cookie-authenticated routes live under `websiteRoutes` (CORS + CSRF origin check + no-store);
  the desktop app's routes under `appRoutes` (no cookies). Don't mix them.
- Admin routes: `requireSession` + `requireAdmin` (DB role + recent sign-in). Every admin
  mutation records an audit entry (`AuditService.record`) — in the same transaction when possible.

## Plans, coupons, plan changes

- Plans/prices/coupons are **admin-managed data**, not code. Products, prices and discounts are
  created in Paddle first (via `CatalogGateway`), then mirrored. Module/feature ids come from
  `domain/catalog/modules.ts` (the app's contract).
- No free tier: no entitling subscription → `plan: null` → nothing unlocked.
- Upgrades/interval switches: prorated immediately (`prevent_change` on payment failure).
  Downgrades: scheduled (`pendingPriceId`), applied by the worker before renewal with
  `do_not_bill`; the old plan stays entitled until `graceUntil`.
- Raw SQL must bind times from the app — never compare to SQL `now()` (timestamps are UTC in
  `timestamp without time zone`).

## Billing (Paddle) — non-negotiable

- Webhooks: verify the signature over the **raw body**; any failure → non-2xx (Paddle retries).
  Only answer 2xx after the transaction committed.
- Every event goes through the `webhook_events` ledger in the same transaction as its effects;
  non-idempotent side effects (emails) go to the **outbox**, never inline.
- Webhooks are unordered: writes must converge (`upsertIfNewer` on `occurred_at`).
- Access is derived from mirrored state by `domain/entitlements` — never stored as a flag.
  `canceled` is terminal; a pending cancel is `active` + `scheduledChange`.
- Reads come from our mirror; the Paddle API is for mutations/portal only.
- Purchases link to accounts by the **HMAC-signed** checkout custom data (server-created
  transaction), else by customer email. Never trust an unsigned client-supplied account id.
- Webhooks: Paddle IP allowlist (fail closed; mandatory in production) + signature.

## Licensing

- License keys and session tokens are stored **only as SHA-256 hashes**.
  A plaintext key appears exactly once: in the issuance/rotation email (and rotation response).
- Tokens are Ed25519 JWS with a `kid`. Rotating keys = new kid; keep old public keys verifiable.
- Plan/module ids are a contract with the desktop app (`domain/entitlements/plans.ts`):
  renaming one is a breaking change.
- Device-limit checks run under a row lock (`lockForUpdate`) inside the activation transaction.

## Errors, logs, security

- Throw `AppError` (stable `code`); `middleware/errorHandler.ts` is the only response formatter.
- Unknown errors → 500 + generic message; details only in logs.
- Structured logs with `requestId`. Never log emails, keys, tokens, cookies or signatures
  (pino redaction is a backstop, not permission).
- Validate body/params/query with zod at the route; parsed values replace raw input.
- Same error for unknown vs malformed credentials (no enumeration). Rate-limit auth + licensing.

## Database

- Every schema change ships with a Prisma migration. Index every column used to filter or sort.
- Financial history is never hard-deleted.

## Tests

- New behaviour = new tests; a bug fix starts with a failing test.
- Services are tested on `MemoryUnitOfWork` (real rollback) via `test/fakes/harness.ts`;
  HTTP behaviour (auth, CSRF, 400/401/403, envelope) with supertest on the real app.
- Anything with raw SQL, locks or aggregates also gets a case in `test/integration` (Postgres).
- Mock only the outside world (Paddle, mail). Never mock the unit under test.
