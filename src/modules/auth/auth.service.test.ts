import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, createHarness } from '../../../test/fakes/harness';
import { safeReturnTo } from './auth.service';

let h: ReturnType<typeof createHarness>;
beforeEach(() => {
  h = createHarness();
});

const complete = (email: string, overrides: { state?: string; stateCookie?: string } = {}) => {
  const { stateCookie } = h.auth.startGoogleSignIn('/account');
  const state = h.identity.lastAuthorization!.state;
  return h.auth.completeGoogleSignIn({
    code: `code:sub-${email}:${email}`,
    state: overrides.state ?? state,
    stateCookie: overrides.stateCookie ?? stateCookie,
  });
};

describe('Google sign-in', () => {
  it('first sign-in registers the account and opens a session', async () => {
    const { sessionToken, account, returnTo } = await complete('new@example.com');
    expect(account).toMatchObject({ email: 'new@example.com', role: 'user' });
    expect(returnTo).toBe('/account');
    expect(await h.auth.authenticate(sessionToken)).toMatchObject({
      email: 'new@example.com',
      role: 'user',
    });
  });

  it('uses PKCE: the verifier sent to Google matches the challenge it was shown', async () => {
    const { createHash } = await import('node:crypto');
    await complete('a@example.com');
    const { codeVerifier, nonce } = h.identity.received[0]!;
    expect(createHash('sha256').update(codeVerifier).digest('base64url')).toBe(
      h.identity.lastAuthorization!.codeChallenge,
    );
    expect(nonce).toBe(h.identity.lastAuthorization!.nonce);
  });

  it('rejects a state that does not match this browser (login CSRF)', async () => {
    await expect(complete('a@example.com', { state: 'attacker-state' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects a missing or tampered state cookie', async () => {
    await expect(complete('a@example.com', { stateCookie: 'forged.cookie' })).rejects.toMatchObject(
      { code: 'UNAUTHENTICATED' },
    );
  });

  it('rejects an expired sign-in attempt (state older than 10 minutes)', async () => {
    const { stateCookie } = h.auth.startGoogleSignIn();
    const state = h.identity.lastAuthorization!.state;
    h.clock.advanceHours(1);
    await expect(
      h.auth.completeGoogleSignIn({ code: 'code:x:x@example.com', state, stateCookie }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('promotes bootstrap admins (ADMIN_EMAILS) and nobody else', async () => {
    expect((await complete(ADMIN_EMAIL)).account.role).toBe('admin');
    expect((await complete('user@example.com')).account.role).toBe('user');
  });

  it('adopts an account created by an earlier purchase with the same email', async () => {
    const bought = await h.uow.repos.accounts.upsertByEmail('buyer@example.com');
    expect((await complete('buyer@example.com')).account.id).toBe(bought.id);
  });
});

describe('sessions', () => {
  it('expire after the idle window, but use keeps them alive', async () => {
    const { sessionToken } = await complete('a@example.com');
    h.clock.advanceDays(6);
    expect(await h.auth.authenticate(sessionToken)).not.toBeNull(); // touch
    h.clock.advanceDays(6);
    expect(await h.auth.authenticate(sessionToken)).not.toBeNull();
    h.clock.advanceDays(8);
    expect(await h.auth.authenticate(sessionToken)).toBeNull();
  });

  it('expire absolutely after the session TTL even when used daily', async () => {
    const { sessionToken } = await complete('a@example.com');
    for (let day = 0; day < 31; day++) {
      h.clock.advanceDays(1);
      await h.auth.authenticate(sessionToken);
    }
    expect(await h.auth.authenticate(sessionToken)).toBeNull();
  });

  it('logout-everywhere ends every session of the account', async () => {
    const a = await complete('a@example.com');
    const b = await complete('a@example.com');
    expect(await h.auth.logoutEverywhere(a.account.id)).toBe(2);
    expect(await h.auth.authenticate(a.sessionToken)).toBeNull();
    expect(await h.auth.authenticate(b.sessionToken)).toBeNull();
  });

  it('stores only hashes of session tokens', async () => {
    const { sessionToken } = await complete('a@example.com');
    expect(JSON.stringify([...h.uow.state.sessions.values()])).not.toContain(sessionToken);
  });
});

describe('safeReturnTo (open-redirect guard)', () => {
  it.each([
    ['/account', '/account'],
    ['/pricing?plan=pro', '/pricing?plan=pro'],
    ['//evil.com', '/account'],
    ['/\\evil.com', '/account'],
    ['https://evil.com', '/account'],
    [undefined, '/account'],
  ])('%s → %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});
