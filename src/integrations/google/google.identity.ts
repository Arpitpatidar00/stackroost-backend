import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { IdentityProvider, VerifiedIdentity } from '@/modules/auth/identity.provider';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Google's signing keys; jose caches and rotates them per Cache-Control.
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/**
 * Google OpenID Connect: authorization code flow with PKCE (S256), state and
 * nonce. The ID token is verified locally against Google's JWKS.
 */
export class GoogleIdentityProvider implements IdentityProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  authorizationUrl({
    state,
    nonce,
    codeChallenge,
  }: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): string {
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  async verifyCallback({
    code,
    codeVerifier,
    nonce,
  }: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<VerifiedIdentity> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`google token exchange failed: ${String(res.status)}`);
    const { id_token: idToken } = (await res.json()) as { id_token?: string };
    if (!idToken) throw new Error('google returned no id_token');

    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: this.clientId,
      clockTolerance: 30,
    });
    if (payload.nonce !== nonce) throw new Error('nonce mismatch');
    if (payload.email_verified !== true || typeof payload.email !== 'string' || !payload.sub) {
      throw new Error('google account email is not verified');
    }
    return {
      subject: payload.sub,
      email: payload.email.toLowerCase(),
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  }
}
