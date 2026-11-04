import { Router } from 'express';
import { publicRoute } from '@/middleware/auth';
import type { RateLimits } from '@/middleware/rateLimits';
import { validate } from '@/shared/http/validate';
import type { LicensesController } from './licenses.controller';
import { activateSchema, deactivateSchema, refreshSchema } from './licenses.validation';

export function licensesRoutes(ctrl: LicensesController, limits: RateLimits): Router {
  const r = Router();
  const app = publicRoute('desktop app: authenticated by license key or signed token');
  r.post('/activate', app, limits.licensing, validate(activateSchema), ctrl.activate);
  r.post('/refresh', app, limits.licensing, validate(refreshSchema), ctrl.refresh);
  r.post('/deactivate', app, limits.licensing, validate(deactivateSchema), ctrl.deactivate);
  // JWKS-style: lets the app/website verify tokens; public keys are public.
  r.get('/keys', publicRoute('public verification keys'), ctrl.publicKeys);
  return r;
}
