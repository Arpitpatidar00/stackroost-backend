import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateLicenseKey,
  isWellFormedLicenseKey,
  normalizeLicenseKey,
  previewLicenseKey,
} from './licenseKey';
import { LicenseTokenSigner, type LicenseClaims } from './licenseToken';

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    pub: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
};

describe('license keys', () => {
  it('generates well-formed, unique keys', () => {
    const keys = new Set(Array.from({ length: 500 }, generateLicenseKey));
    expect(keys.size).toBe(500);
    for (const k of keys) expect(isWellFormedLicenseKey(k)).toBe(true);
  });

  it('normalises sloppy user input to the canonical key', () => {
    const key = generateLicenseKey();
    const sloppy = `  ${key.toLowerCase().replace(/-/g, ' ')} `;
    expect(normalizeLicenseKey(sloppy)).toBe(key);
  });

  it('maps look-alike characters (O→0, I/L→1)', () => {
    expect(normalizeLicenseKey('sr-OOOOO-IIIII-LLLLL-22222-33333')).toBe(
      'SR-00000-11111-11111-22222-33333',
    );
  });

  it('previews without revealing the key', () => {
    const key = 'SR-ABCDE-FGHJK-MNPQR-STVWX-YZ012';
    expect(previewLicenseKey(key)).toBe('SR-ABCDE…Z012');
  });
});

describe('LicenseTokenSigner', () => {
  const claims: LicenseClaims = {
    sub: 'lic_1',
    dev: 'dev_1',
    plan: 'pro',
    modules: ['homebrew', 'remote'],
    features: ['maclean.deep_scan'],
    iat: 1,
    exp: 2,
  };

  it('round-trips signed claims', () => {
    const { priv, pub } = pair();
    const signer = new LicenseTokenSigner(priv, pub, 'k1');
    expect(signer.verify(signer.sign(claims))).toEqual(claims);
  });

  it('rejects a tampered payload', () => {
    const { priv, pub } = pair();
    const signer = new LicenseTokenSigner(priv, pub, 'k1');
    const [h, , s] = signer.sign(claims).split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, plan: 'pro', exp: 9e9 })).toString(
      'base64url',
    );
    expect(signer.verify(`${h}.${forged}.${s}`)).toBeNull();
  });

  it('rejects a token from another key or key id', () => {
    const a = pair();
    const b = pair();
    const token = new LicenseTokenSigner(a.priv, a.pub, 'k1').sign(claims);
    expect(new LicenseTokenSigner(b.priv, b.pub, 'k1').verify(token)).toBeNull();
    expect(new LicenseTokenSigner(a.priv, a.pub, 'k2').verify(token)).toBeNull();
  });

  it('rejects garbage', () => {
    const { priv, pub } = pair();
    const signer = new LicenseTokenSigner(priv, pub, 'k1');
    for (const t of ['', 'a.b', 'a.b.c', '...']) expect(signer.verify(t)).toBeNull();
  });

  it('publishes an Ed25519 JWK with its key id', () => {
    const { priv, pub } = pair();
    const jwk = new LicenseTokenSigner(priv, pub, 'k9').publicJwk();
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: 'k9', alg: 'EdDSA' });
    expect(jwk).not.toHaveProperty('d');
  });
});
