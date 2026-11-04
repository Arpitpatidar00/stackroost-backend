# Integration guide — website, desktop app, admin panel

All website calls use `fetch(url, { credentials: 'include' })` and run on the website origin
(the API rejects state-changing requests from any other Origin). Host the API on a subdomain
of the website (e.g. `api.stackroost.dev`).

## Website

### 1. Register / sign in (Google)

A plain link — no JavaScript SDK needed:

```html
<a href="https://api.stackroost.dev/v1/auth/google?returnTo=/pricing">Continue with Google</a>
```

The API redirects to Google and back, sets the session cookie, then redirects to
`${WEBSITE_URL}${returnTo}`. On failure it redirects to `/login?error=failed|cancelled` —
build that page. `GET /v1/auth/me` → `{ account: { id, email, role } }` or 401.

### 2. Pricing page

`GET /v1/plans` →
`{ plans: [{ key, name, description, rank, modules, features, prices: [{ priceId, interval, amountMinor, currency }] }], checkout: { environment, clientToken } }`.
Show modules per plan; everything is locked without a subscription.

### 3. Subscribe (with an optional coupon)

```js
// optional: show the discount before paying
await api('/v1/billing/coupons/preview', { priceId, code }); // → { code, type, amount, … } or 422 COUPON_INVALID

const { transactionId } = await api('/v1/billing/checkout', { priceId, couponCode }); // 201
Paddle.Environment.set(checkout.environment === 'sandbox' ? 'sandbox' : undefined); // omit in live
Paddle.Initialize({ token: checkout.clientToken });
Paddle.Checkout.open({
  transactionId,
  settings: { successUrl: `${location.origin}/account?welcome=1` },
});
```

The transaction is created server-side and bound to the signed-in account. `409
ALREADY_SUBSCRIBED` → send them to "Change plan". After payment the account page shows the plan
within seconds (webhook), and the license key arrives by email.

### 4. Account page

`GET /v1/account` →
`{ email, plan: { key, name, modules, features } | null, subscription: { id, status, currentPeriodEndsAt, scheduledChange, pendingPlanChange, paymentFailing } | null, license: { keyPreview, maxDevices, devices[] } | null }`.

- `paymentFailing` → banner + **Manage billing** (`POST /v1/billing/portal` → redirect to `url`).
- `scheduledChange.action === 'cancel'` → "Your plan ends on …".
- `pendingPlanChange` → "Switching to Basic on …" + **Keep my plan** (`DELETE /v1/billing/subscription/change`).
- Devices: **Remove** → `DELETE /v1/account/devices/:id`. **Replace key** → `POST /v1/account/license/rotate` (show `licenseKey` once).

### 5. Change plan (Pro ↔ Max …)

```js
const p = await api('/v1/billing/subscription/change/preview', { priceId });
// upgrade / interval_switch: p.dueNow = { amount, currency, action }  → "Pay 12.40 now"
// downgrade:                 p.effectiveAt = period end              → "Switches on Dec 2"
await api('/v1/billing/subscription/change', { priceId });
```

Errors: `PLAN_CHANGE_INVALID` (payment failing, cancellation scheduled, same plan, currency).

## Desktop app (Stackroost)

1. **Embed** the public key from `GET /v1/licenses/keys` (JWK + `kid`) at build time.
2. **Activate** (Settings → License): `POST /v1/licenses/activate { licenseKey, deviceId, deviceName, appVersion }`
   → `{ token, expiresAt, plan, modules, features }`. `deviceId`: an opaque hash of the machine id
   (e.g. SHA-256 of `IOPlatformUUID` + app salt), never the raw hardware id. Keep `token` in the Keychain.
3. **Every launch**: verify the token **offline** (Ed25519 over `header.payload`, known `kid`,
   `dev` == this device). Unlock exactly `modules` / `features`; `plan: null` = everything locked +
   "Subscribe" (link to the pricing page).
4. **Refresh** in the background when < 7 days remain or after "I upgraded":
   `POST /v1/licenses/refresh { token, appVersion }` — picks up upgrades/downgrades. Offline is
   fine until `exp`; then show locked and retry. 30 days past `exp`, or after the device was
   removed, the user must activate again.
5. **Sign out**: `POST /v1/licenses/deactivate { licenseKey, deviceId }`.
6. Declare the API host in the app's `core::net::declared_destinations()` (Settings → Privacy).

Errors: `LICENSE_INVALID`, `LICENSE_REVOKED`, `DEVICE_LIMIT_REACHED` (409 → account page), `RATE_LIMITED`.

## Admin panel (later — the API is ready)

Sign in with Google as an `ADMIN_EMAILS` account. Admin calls need a sign-in younger than 12 h
(`401 REAUTH_REQUIRED` → send through Google sign-in again). Typical screens:

- **Dashboard** — `GET /v1/admin/stats` → `{ accounts, subscriptionsByPlan, mrrMinor }`.
- **Plans** — list/create/edit (`modules` from the app catalogue), add prices (creates them in Paddle),
  deactivate prices (stops new sales; existing subscribers unaffected).
- **Coupons** — create (`percentage` 1–100 or `flat` + currency; `recurring` + `maxRecurringIntervals`;
  `usageLimit`; `expiresAt`; `planIds`), activate/deactivate.
- **Subscriptions** — search/filter, detail, cancel / pause (`immediately` | `next_billing_period`), resume.
- **Accounts** — search, detail (plan, license, devices), set role, revoke/restore license, sign out everywhere.
- **Audit log** — every admin action, filterable by actor/target.

## Paddle dashboard setup (sandbox first)

1. Notifications → destination `${API_URL}/v1/webhooks/paddle`; events: `subscription.*`,
   `customer.created`, `customer.updated` → secret into `PADDLE_WEBHOOK_SECRET`.
2. Developer tools → client-side token → `PADDLE_CLIENT_TOKEN`; API key → `PADDLE_API_KEY`
   (permissions: products, prices, discounts, customers, transactions, subscriptions, customer portal).
3. Create the plans' prices through the admin API (not the dashboard) so they're mirrored.
4. Checkout settings → default payment link = your website's checkout page.
