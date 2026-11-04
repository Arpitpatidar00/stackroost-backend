# Security model & production checklist

## Controls (what protects what)

| Area                    | Control                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sign-in**             | Google OIDC, authorization code + **PKCE (S256)**, `state` bound to the browser by a signed, httpOnly, 10-minute cookie, `nonce` checked in the ID token; ID token verified against Google's JWKS (issuer, audience, expiry); only **verified** Google emails. Post-login redirect limited to same-site paths (no open redirect).                         |
| **Sessions**            | 256-bit random tokens, stored as SHA-256 only. Cookie: `__Host-` prefix (prod), `HttpOnly`, `Secure`, `SameSite=Lax`. Absolute (30 d) + idle (7 d) expiry; logout-everywhere; role changes revoke all sessions.                                                                                                                                           |
| **CSRF**                | SameSite=Lax **plus** an Origin allowlist check on every state-changing cookie-authenticated request.                                                                                                                                                                                                                                                     |
| **Authorization**       | Every route declares `requireSession` or `publicRoute('why')`. Admin = role read from the DB on each request + sign-in younger than 12 h (`REAUTH_REQUIRED`). Ownership enforced in services (devices, licenses, subscriptions are always scoped to the session's account). Admins can't demote themselves.                                               |
| **Audit**               | Every admin mutation → `audit_logs` (actor, action, target, metadata, IP), in the same transaction where possible.                                                                                                                                                                                                                                        |
| **Payments**            | Paddle is the merchant of record and source of truth. Checkout transactions are created **server-side**; the account link in custom data is **HMAC-signed** and verified on the webhook (no attaching purchases to other accounts). Upgrades use `prevent_change` on payment failure. Coupons are Paddle discounts (Paddle enforces limits/expiry again). |
| **Webhooks**            | Source IP must be in Paddle's published list (`api.paddle.com/ips`, fetched + cached, **fail-closed**; mandatory in production) **and** the HMAC signature over the raw body must verify. Event-id ledger (exactly-once effects), convergent writes (out-of-order safe).                                                                                  |
| **Licensing**           | Keys stored as SHA-256; shown once. Ed25519-signed tokens (`kid` for rotation) verified offline by the app; device-bound; device limit enforced under a row lock; same error for unknown/malformed keys (no enumeration); revocation.                                                                                                                     |
| **Abuse**               | Per-route rate limits in a **shared Postgres store** (correct across instances): sign-in, billing (per account), coupon guessing, licensing, admin. IPv6 grouped by /56.                                                                                                                                                                                  |
| **Input**               | zod on body/params/query; parsed values replace raw input; admin input `.strict()` (unknown keys rejected); module/feature ids validated against the app's catalogue; 32 KB JSON limit.                                                                                                                                                                   |
| **Transport / headers** | Helmet: CSP `default-src 'none'`, HSTS (prod, preload), nosniff, frame-deny, CORP same-site; `Cache-Control: no-store` on authenticated responses; CORS only for the website origin.                                                                                                                                                                      |
| **Secrets & config**    | Only `config/env.ts` reads env; boot fails on missing values and on insecure production config (non-https URLs, sandbox key in prod, IP allowlist off). No secrets in code or logs; pino redaction for cookies, signatures, tokens, emails.                                                                                                               |
| **Data**                | Every schema change is a migration; CI applies migrations to an empty DB and runs the Postgres suite.                                                                                                                                                                                                                                                     |

## Production checklist

- [ ] HTTPS everywhere; API on a subdomain of the website (e.g. `api.stackroost.dev`) so the
      SameSite session cookie works; `TRUST_PROXY_HOPS` matches your load balancer.
- [ ] Secrets in a secret manager (not files): `SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`,
      `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `LICENSE_SIGNING_PRIVATE_KEY`.
- [ ] Google OAuth client: authorised redirect URI = `${API_URL}/v1/auth/google/callback`;
      consent screen published.
- [ ] Paddle (live): notification destination → `${API_URL}/v1/webhooks/paddle`; live client token;
      live API key with least-privilege permissions; website domain approved.
- [ ] Real `Mailer` adapter (Resend/Postmark/SES) with SPF/DKIM/DMARC on the sending domain.
- [ ] `ADMIN_EMAILS` set to the founders only; manage other admins via the API.
- [ ] Postgres: TLS, automated backups + restore drill, least-privilege app user (no superuser).
- [ ] Run the API and the worker as separate processes; health checks on `/health/ready`.
- [ ] Log shipping + alerts on: webhook 4xx/5xx spikes, `outbox_jobs.status = 'failed'`,
      `scheduled downgrade failed`, 429 spikes, 5xx rate.
- [ ] Dependency audit in CI (`npm audit --omit=dev --audit-level=high`, already wired).
