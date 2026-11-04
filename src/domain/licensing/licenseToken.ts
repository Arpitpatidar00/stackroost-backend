import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * Offline-verifiable license token: a compact JWS (EdDSA / Ed25519).
 * The desktop app embeds the public key and verifies locally — no network
 * call to open the app, and nothing the user could edit to unlock Pro.
 */
export interface LicenseClaims {
  /** License id. */
  sub: string;
  /** Device id the token is bound to. */
  dev: string;
  /** Plan key ("basic" | "pro" | "max" | admin-defined), or null = nothing unlocked. */
  plan: string | null;
  modules: readonly string[];
  features: readonly string[];
  /** Issued-at / expiry, seconds since epoch. The app refreshes before exp. */
  iat: number;
  exp: number;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class LicenseTokenSigner {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    privatePem: string,
    publicPem: string,
    readonly keyId: string,
  ) {
    this.privateKey = createPrivateKey(privatePem);
    this.publicKey = createPublicKey(publicPem);
    if (this.privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('LICENSE_SIGNING_PRIVATE_KEY must be an Ed25519 key');
    }
  }

  sign(claims: LicenseClaims): string {
    const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: this.keyId }));
    const payload = b64u(JSON.stringify(claims));
    const signature = sign(null, Buffer.from(`${header}.${payload}`), this.privateKey);
    return `${header}.${payload}.${b64u(signature)}`;
  }

  /** Verifies signature + key id; returns claims or null. Expiry is the caller's call. */
  verify(token: string): LicenseClaims | null {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) return null;
    try {
      const h = JSON.parse(Buffer.from(header, 'base64url').toString()) as {
        alg?: string;
        kid?: string;
      };
      if (h.alg !== 'EdDSA' || h.kid !== this.keyId) return null;
      const valid = verify(
        null,
        Buffer.from(`${header}.${payload}`),
        this.publicKey,
        Buffer.from(signature, 'base64url'),
      );
      if (!valid) return null;
      return JSON.parse(Buffer.from(payload, 'base64url').toString()) as LicenseClaims;
    } catch {
      return null;
    }
  }

  /** Public key as a JWK (served to the app/website for verification). */
  publicJwk() {
    return {
      ...this.publicKey.export({ format: 'jwk' }),
      kid: this.keyId,
      alg: 'EdDSA',
      use: 'sig',
    };
  }
}
