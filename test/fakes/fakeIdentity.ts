import type { IdentityProvider, VerifiedIdentity } from '@/modules/auth/identity.provider';

/**
 * Fake Google. The authorization code IS the identity ("code:<sub>:<email>"),
 * so tests choose who signs in. Records the nonce/verifier it was given.
 */
export class FakeIdentityProvider implements IdentityProvider {
  lastAuthorization: { state: string; nonce: string; codeChallenge: string } | null = null;
  received: { code: string; codeVerifier: string; nonce: string }[] = [];

  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }) {
    this.lastAuthorization = input;
    return `https://accounts.google.test/auth?state=${input.state}`;
  }

  verifyCallback(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<VerifiedIdentity> {
    this.received.push(input);
    const [prefix, subject, email] = input.code.split(':');
    if (prefix !== 'code' || !subject || !email) return Promise.reject(new Error('invalid code'));
    return Promise.resolve({ subject, email, name: `User ${subject}` });
  }
}
