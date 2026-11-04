import { createHash, createHmac } from 'node:crypto';
import { safeEqual } from './tokens';

/**
 * Tamper-proof, expiring values: `base64url(json).base64url(hmac)`. Used for
 * the OAuth state cookie. Not encrypted — never put secrets inside.
 */
export class Signer {
  constructor(private readonly secret: string) {}

  /** HMAC-SHA256 of a string (also used to sign checkout custom data). */
  mac(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  verifyMac(value: string, mac: string): boolean {
    return safeEqual(this.mac(value), mac);
  }

  sign(payload: object, ttlMs: number, now: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs })).toString(
      'base64url',
    );
    return `${body}.${this.mac(body)}`;
  }

  /** Authentic and unexpired → the payload (`unknown`: callers validate its shape). */
  verify(token: string, now: number): unknown {
    const [body, mac] = token.split('.');
    if (!body || !mac || !this.verifyMac(body, mac)) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as { exp?: unknown };
      return typeof data.exp === 'number' && data.exp > now ? data : null;
    } catch {
      return null;
    }
  }
}

/** PKCE S256 challenge for a code verifier. */
export const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');
