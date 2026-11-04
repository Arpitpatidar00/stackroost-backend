import { Router, type RequestHandler } from 'express';
import type { RateLimits } from '@/middleware/rateLimits';
import { validate } from '@/shared/http/validate';
import type { AdminController } from './admin.controller';
import * as s from './admin.validation';

/**
 * /v1/admin — every route: session → admin role (from DB) + recent sign-in →
 * per-admin rate limit → validation. Mutations are audited in the services.
 */
export function adminRoutes(
  ctrl: AdminController,
  session: RequestHandler,
  requireAdmin: RequestHandler,
  limits: RateLimits,
): Router {
  const r = Router();
  r.use(session, requireAdmin, limits.admin);

  r.get('/stats', ctrl.stats);

  r.get('/accounts', validate(s.listAccountsSchema), ctrl.listAccounts);
  r.get('/accounts/:id', validate(s.accountIdSchema), ctrl.account);
  r.patch('/accounts/:id/role', validate(s.setRoleSchema), ctrl.setRole);
  r.post('/accounts/:id/license/revoke', validate(s.accountIdSchema), ctrl.revokeLicense);
  r.post('/accounts/:id/license/restore', validate(s.accountIdSchema), ctrl.restoreLicense);
  r.post('/accounts/:id/sessions/revoke', validate(s.accountIdSchema), ctrl.revokeSessions);

  r.get('/plans', ctrl.listPlans);
  r.post('/plans', validate(s.createPlanSchema), ctrl.createPlan);
  r.patch('/plans/:id', validate(s.updatePlanSchema), ctrl.updatePlan);
  r.post('/plans/:id/prices', validate(s.createPriceSchema), ctrl.createPrice);
  r.patch('/prices/:id', validate(s.setActiveSchema), ctrl.setPriceActive);

  r.get('/coupons', validate(s.listCouponsSchema), ctrl.listCoupons);
  r.post('/coupons', validate(s.createCouponSchema), ctrl.createCoupon);
  r.patch('/coupons/:id', validate(s.setActiveSchema), ctrl.setCouponActive);

  r.get('/subscriptions', validate(s.listSubscriptionsSchema), ctrl.listSubscriptions);
  r.get('/subscriptions/:id', validate(s.subscriptionIdSchema), ctrl.subscription);
  r.post(
    '/subscriptions/:id/cancel',
    validate(s.subscriptionActionSchema),
    ctrl.cancelSubscription,
  );
  r.post('/subscriptions/:id/pause', validate(s.subscriptionActionSchema), ctrl.pauseSubscription);
  r.post('/subscriptions/:id/resume', validate(s.subscriptionIdSchema), ctrl.resumeSubscription);

  r.get('/audit-log', validate(s.auditLogSchema), ctrl.auditLog);
  return r;
}
