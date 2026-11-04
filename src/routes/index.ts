import { Router } from 'express';
import type { Container } from '@/container';
import { accountRoutes } from '@/modules/account/account.routes';
import { adminRoutes } from '@/modules/admin/admin.routes';
import { authRoutes } from '@/modules/auth/auth.routes';
import { billingRoutes } from '@/modules/billing/billing.routes';
import { catalogRoutes } from '@/modules/catalog/catalog.routes';
import { licensesRoutes } from '@/modules/licenses/licenses.routes';

/** Cookie-authenticated website API (CSRF + no-store applied in app.ts). */
export function websiteRoutes(c: Container): Router {
  const { session, admin } = c.guards;
  const r = Router();
  r.use('/plans', catalogRoutes(c.services.catalog));
  r.use('/auth', authRoutes(c.controllers.auth, session, c.limits));
  r.use('/account', accountRoutes(c.controllers.account, session));
  r.use('/billing', billingRoutes(c.controllers.billing, session, c.limits));
  r.use('/admin', adminRoutes(c.controllers.admin, session, admin, c.limits));
  return r;
}

/** Desktop app API: no cookies; authenticated by license key / signed token. */
export function appRoutes(c: Container): Router {
  const r = Router();
  r.use('/licenses', licensesRoutes(c.controllers.licenses, c.limits));
  return r;
}
