import type { Request, RequestHandler } from 'express';
import type { Actor } from '@/modules/audit/audit.service';
import type { AuthService, SessionPrincipal } from '@/modules/auth/auth.service';
import type { Clock } from '@/shared/clock';
import { AppError } from '@/shared/errors/AppError';

/**
 * `__Host-` (production): Secure, Path=/, no Domain — the browser refuses to
 * let any other (sub)domain set or overwrite it.
 */
export const sessionCookieName = (secure: boolean) => (secure ? '__Host-sr_session' : 'sr_session');

/** Website routes: resolves the session cookie to `req.auth`, or 401. */
export const requireSession =
  (auth: AuthService, cookieName: string): RequestHandler =>
  async (req, _res, next) => {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const token = cookies?.[cookieName];
    const principal = typeof token === 'string' && token ? await auth.authenticate(token) : null;
    if (!principal) {
      next(AppError.unauthenticated());
      return;
    }
    req.auth = principal;
    next();
  };

/**
 * Admin routes. The role comes from the database on every request (a demoted
 * admin loses access immediately), and the sign-in must be recent: a stolen
 * long-lived session can't be used to run admin actions for weeks.
 */
export const requireAdmin =
  (clock: Clock, recentAuthHours: number): RequestHandler =>
  (req, _res, next) => {
    const auth = req.auth;
    if (auth?.role !== 'admin') {
      next(AppError.forbidden());
      return;
    }
    if (clock.now().getTime() - auth.authenticatedAt.getTime() > recentAuthHours * 3_600_000) {
      next(new AppError('REAUTH_REQUIRED', 'Sign in again to continue with admin actions.', 401));
      return;
    }
    next();
  };

/** Explicit, greppable marker for routes that are intentionally unauthenticated. */
export const publicRoute =
  (_why: string): RequestHandler =>
  (_req, _res, next) => {
    next();
  };

export function principal(req: Request): SessionPrincipal {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth;
}

export const actorOf = (req: Request): Actor => ({
  accountId: principal(req).accountId,
  ip: req.ip ?? null,
});
