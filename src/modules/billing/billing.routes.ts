import express, { Router, type RequestHandler } from 'express';
import { publicRoute } from '@/middleware/auth';
import type { RateLimits } from '@/middleware/rateLimits';
import { validate } from '@/shared/http/validate';
import type { BillingController } from './billing.controller';
import { checkoutSchema, couponPreviewSchema, planChangeSchema } from './billing.validation';

/** Mounted BEFORE the JSON body parser (app.ts): verification needs the raw bytes. */
export function billingWebhookRoutes(ctrl: BillingController, ipAllowlist: RequestHandler): Router {
  const r = Router();
  r.post(
    '/paddle',
    publicRoute('Paddle → us; Paddle IPs + HMAC signature'),
    ipAllowlist,
    express.raw({ type: '*/*', limit: '1mb' }),
    ctrl.paddleWebhook,
  );
  return r;
}

/** Signed-in subscriber actions. Ownership = the session's account, enforced in services. */
export function billingRoutes(
  ctrl: BillingController,
  session: RequestHandler,
  limits: RateLimits,
): Router {
  const r = Router();
  r.post('/checkout', session, limits.billing, validate(checkoutSchema), ctrl.startCheckout);
  r.post(
    '/coupons/preview',
    session,
    limits.coupons,
    validate(couponPreviewSchema),
    ctrl.previewCoupon,
  );
  r.post(
    '/subscription/change/preview',
    session,
    limits.billing,
    validate(planChangeSchema),
    ctrl.previewChange,
  );
  r.post(
    '/subscription/change',
    session,
    limits.billing,
    validate(planChangeSchema),
    ctrl.changePlan,
  );
  r.delete('/subscription/change', session, ctrl.cancelScheduledChange);
  r.post('/portal', session, limits.billing, ctrl.portal);
  return r;
}
