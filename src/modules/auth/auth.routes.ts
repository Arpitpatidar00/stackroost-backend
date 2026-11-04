import { Router, type RequestHandler } from 'express';
import { publicRoute } from '@/middleware/auth';
import type { RateLimits } from '@/middleware/rateLimits';
import { validate } from '@/shared/http/validate';
import type { AuthController } from './auth.controller';
import { googleCallbackSchema, startGoogleSchema } from './auth.validation';

export function authRoutes(
  ctrl: AuthController,
  session: RequestHandler,
  limits: RateLimits,
): Router {
  const r = Router();
  r.get(
    '/google',
    publicRoute('registration / sign-in starts here'),
    limits.auth,
    validate(startGoogleSchema),
    ctrl.startGoogle,
  );
  r.get(
    '/google/callback',
    publicRoute('Google redirects back; verified by state + PKCE'),
    limits.auth,
    validate(googleCallbackSchema),
    ctrl.googleCallback,
  );
  r.get('/me', session, ctrl.me);
  r.post('/logout', session, ctrl.logout);
  r.post('/logout-all', session, ctrl.logoutEverywhere);
  return r;
}
