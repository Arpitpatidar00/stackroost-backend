/** Port: an OpenID Connect identity provider (Google). */
export interface VerifiedIdentity {
  /** Stable subject id at the provider. */
  subject: string;
  email: string;
  name: string | null;
}

export interface IdentityProvider {
  /** URL to send the browser to (authorization code + PKCE). */
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string;
  /**
   * Exchanges the code and verifies the ID token (signature, issuer, audience,
   * expiry, nonce, verified email). Throws on any failure.
   */
  verifyCallback(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<VerifiedIdentity>;
}
