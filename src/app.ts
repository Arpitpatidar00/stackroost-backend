import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Container } from '@/container';
import { errorHandler, notFound } from '@/middleware/errorHandler';
import { requestId } from '@/middleware/requestId';
import { requestLogger } from '@/middleware/requestLogger';
import { noStore, requireTrustedOrigin, webhookIpAllowlist } from '@/middleware/security';
import { billingWebhookRoutes } from '@/modules/billing/billing.routes';
import { healthRoutes } from '@/modules/health/health.routes';
import { appRoutes, websiteRoutes } from '@/routes';

/** Builds the Express app (no listen) — tests drive it in-process. */
export function createApp(c: Container): Express {
  const { env, infra } = c;
  const app = express();
  const origins = [new URL(env.WEBSITE_URL).origin, ...env.CORS_EXTRA_ORIGINS];

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.use(requestId);
  app.use(requestLogger(infra.log));
  // JSON API: deny all content sources; HSTS in production.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      strictTransportSecurity:
        env.NODE_ENV === 'production'
          ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
          : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use('/health', healthRoutes(infra.checkDatabase));
  // Webhooks: server-to-server, raw body, Paddle IPs only — before any body parser or CORS.
  app.use(
    '/v1/webhooks',
    c.limits.general,
    billingWebhookRoutes(c.controllers.billing, webhookIpAllowlist(infra.webhookIps, infra.log)),
  );

  app.use(express.json({ limit: '32kb', strict: true }));
  // One general budget per request for the whole API (route limits stack on top).
  app.use('/v1', c.limits.general);

  // Desktop app: no cookies, no CORS (not a browser).
  app.use('/v1', appRoutes(c));

  // Website: CORS for our origins only, cookies, CSRF origin check, never cached.
  app.use(
    '/v1',
    cors({ origin: origins, credentials: true, maxAge: 600 }),
    cookieParser(),
    requireTrustedOrigin(origins),
    noStore,
    websiteRoutes(c),
  );

  app.use(notFound);
  app.use(errorHandler(infra.log));
  return app;
}
