import { z } from 'zod';
import type { UnitOfWork } from '@/db/unitOfWork';
import type { Role } from '@/generated/prisma/client';
import { addDays, type Clock } from '@/shared/clock';
import { pkceChallenge, type Signer } from '@/shared/crypto/signed';
import { randomToken, safeEqual, sha256 } from '@/shared/crypto/tokens';
import { AppError } from '@/shared/errors/AppError';
import type { IdentityProvider } from './identity.provider';

export interface AuthConfig {
  sessionTtlDays: number;
  sessionIdleDays: number;
  adminEmails: readonly string[];
}

export interface SessionPrincipal {
  accountId: string;
  email: string;
  role: Role;
  sessionId: string;
  /** When this session was created by a fresh Google sign-in. */
  authenticatedAt: Date;
}

/** The signed state cookie's contents — re-validated after the signature check. */
const oauthStateSchema = z.object({
  state: z.string().min(20),
  verifier: z.string().min(43),
  nonce: z.string().min(20),
  returnTo: z.string(),
});
type OAuthState = z.infer<typeof oauthStateSchema>;

const STATE_TTL_MS = 10 * 60 * 1000;
/** Sliding idle expiry is refreshed at most this often (bounded write load). */
const TOUCH_EVERY_MS = 5 * 60 * 1000;

/**
 * Only same-site relative paths: blocks open redirects (`//evil.com`,
 * `/\evil.com`, `https://…`) after sign-in.
 */
export function safeReturnTo(path: string | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return '/account';
  }
  return path.slice(0, 512);
}

/**
 * Registration and sign-in with Google (OpenID Connect, code + PKCE). The
 * first sign-in creates the account. Sessions are random 256-bit tokens stored
 * only as SHA-256, with absolute and idle expiry.
 */
export class AuthService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly identity: IdentityProvider,
    private readonly signer: Signer,
    private readonly clock: Clock,
    private readonly config: AuthConfig,
  ) {}

  /** Step 1: where to send the browser, plus the signed state cookie binding this browser. */
  startGoogleSignIn(returnTo?: string): {
    redirectUrl: string;
    stateCookie: string;
    maxAgeMs: number;
  } {
    const flow: OAuthState = {
      state: randomToken(),
      verifier: randomToken(48),
      nonce: randomToken(),
      returnTo: safeReturnTo(returnTo),
    };
    return {
      redirectUrl: this.identity.authorizationUrl({
        state: flow.state,
        nonce: flow.nonce,
        codeChallenge: pkceChallenge(flow.verifier),
      }),
      stateCookie: this.signer.sign(flow, STATE_TTL_MS, this.clock.now().getTime()),
      maxAgeMs: STATE_TTL_MS,
    };
  }

  /** Step 2: Google redirected back. Verifies state (CSRF), code (PKCE) and ID token. */
  async completeGoogleSignIn(input: {
    code: string;
    state: string;
    stateCookie: string | undefined;
  }) {
    const parsed = oauthStateSchema.safeParse(
      input.stateCookie ? this.signer.verify(input.stateCookie, this.clock.now().getTime()) : null,
    );
    const flow = parsed.success ? parsed.data : null;
    if (!flow || !safeEqual(flow.state, input.state)) {
      throw AppError.unauthenticated('Sign-in expired or was started elsewhere. Try again.');
    }
    let identity;
    try {
      identity = await this.identity.verifyCallback({
        code: input.code,
        codeVerifier: flow.verifier,
        nonce: flow.nonce,
      });
    } catch {
      throw AppError.unauthenticated('Google sign-in failed. Try again.');
    }

    return this.uow.transaction(async (tx) => {
      const now = this.clock.now();
      const account = await tx.accounts.upsertGoogleIdentity({
        googleSub: identity.subject,
        email: identity.email,
        name: identity.name,
        promoteToAdmin: this.config.adminEmails.includes(identity.email),
        now,
      });
      const sessionToken = randomToken();
      const expiresAt = addDays(now, this.config.sessionTtlDays);
      await tx.auth.createSession({
        tokenHash: sha256(sessionToken),
        accountId: account.id,
        expiresAt,
        now,
      });
      return {
        sessionToken,
        expiresAt,
        returnTo: flow.returnTo,
        account: { id: account.id, email: account.email, name: account.name, role: account.role },
      };
    });
  }

  async authenticate(sessionToken: string): Promise<SessionPrincipal | null> {
    const now = this.clock.now();
    const session = await this.uow.repos.auth.findActiveSession(
      sha256(sessionToken),
      now,
      addDays(now, -this.config.sessionIdleDays),
    );
    if (!session) return null;
    if (now.getTime() - session.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      await this.uow.repos.auth.touch(session.id, now);
    }
    return {
      accountId: session.accountId,
      email: session.account.email,
      role: session.account.role,
      sessionId: session.id,
      authenticatedAt: session.createdAt,
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.uow.repos.auth.deleteSession(sessionId);
  }

  async logoutEverywhere(accountId: string): Promise<number> {
    return this.uow.repos.auth.deleteAccountSessions(accountId);
  }

  /** Worker housekeeping. */
  purgeExpiredSessions(): Promise<number> {
    const now = this.clock.now();
    return this.uow.repos.auth.purgeExpired(now, addDays(now, -this.config.sessionIdleDays));
  }
}
