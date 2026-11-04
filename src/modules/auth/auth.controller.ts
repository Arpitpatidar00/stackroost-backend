import type { CookieOptions, Request, Response } from 'express';
import { principal } from '@/middleware/auth';
import { noContent, ok } from '@/shared/http/response';
import { input } from '@/shared/http/validate';
import type { AuthService } from './auth.service';
import { googleCallbackSchema, startGoogleSchema } from './auth.validation';

const STATE_COOKIE = 'sr_oauth';

export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly websiteUrl: string,
    private readonly sessionCookie: string,
    private readonly secureCookies: boolean,
  ) {}

  private cookie(path: string, extra: CookieOptions = {}): CookieOptions {
    return { httpOnly: true, secure: this.secureCookies, sameSite: 'lax', path, ...extra };
  }

  /** GET /auth/google → 302 to Google with a state cookie bound to this browser. */
  startGoogle = (req: Request, res: Response) => {
    const { query } = input(req, startGoogleSchema);
    const { redirectUrl, stateCookie, maxAgeMs } = this.auth.startGoogleSignIn(query.returnTo);
    res.cookie(STATE_COOKIE, stateCookie, this.cookie('/v1/auth/google', { maxAge: maxAgeMs }));
    res.redirect(302, redirectUrl);
  };

  /** GET /auth/google/callback → session cookie → 302 back to the website. Errors never echo details. */
  googleCallback = async (req: Request, res: Response) => {
    const { query } = input(req, googleCallbackSchema);
    const cookies = req.cookies as Record<string, string | undefined>;
    res.clearCookie(STATE_COOKIE, this.cookie('/v1/auth/google'));
    if ('error' in query) {
      res.redirect(302, new URL('/login?error=cancelled', this.websiteUrl).toString());
      return;
    }
    try {
      const { sessionToken, expiresAt, returnTo } = await this.auth.completeGoogleSignIn({
        code: query.code,
        state: query.state,
        stateCookie: cookies[STATE_COOKIE],
      });
      res.cookie(this.sessionCookie, sessionToken, this.cookie('/', { expires: expiresAt }));
      res.redirect(302, new URL(returnTo, this.websiteUrl).toString());
    } catch {
      res.redirect(302, new URL('/login?error=failed', this.websiteUrl).toString());
    }
  };

  me = (req: Request, res: Response) => {
    const { accountId, email, role } = principal(req);
    ok(res, { account: { id: accountId, email, role } });
  };

  logout = async (req: Request, res: Response) => {
    await this.auth.logout(principal(req).sessionId);
    res.clearCookie(this.sessionCookie, this.cookie('/'));
    noContent(res);
  };

  logoutEverywhere = async (req: Request, res: Response) => {
    await this.auth.logoutEverywhere(principal(req).accountId);
    res.clearCookie(this.sessionCookie, this.cookie('/'));
    noContent(res);
  };
}
