import { describe, expect, it } from 'vitest';
import { pkceChallenge, Signer } from './signed';

const signer = new Signer('s'.repeat(32));

describe('Signer', () => {
  it('round-trips an unexpired payload', () => {
    const token = signer.sign({ state: 'abc' }, 1000, 0);
    expect(signer.verify(token, 500)).toMatchObject({ state: 'abc' });
  });

  it('rejects expired, tampered or foreign tokens', () => {
    const token = signer.sign({ state: 'abc' }, 1000, 0);
    expect(signer.verify(token, 1000)).toBeNull();
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ state: 'evil', exp: 9e15 })).toString('base64url');
    expect(signer.verify(`${forged}.${mac}`, 0)).toBeNull();
    expect(signer.verify(`${body}.${mac}x`, 0)).toBeNull();
    expect(new Signer('t'.repeat(32)).verify(token, 0)).toBeNull();
    expect(signer.verify('garbage', 0)).toBeNull();
  });

  it('macs are stable and verifiable', () => {
    expect(signer.verifyMac('acc_1', signer.mac('acc_1'))).toBe(true);
    expect(signer.verifyMac('acc_2', signer.mac('acc_1'))).toBe(false);
  });

  it('computes the RFC 7636 S256 challenge', () => {
    // Appendix B test vector.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
