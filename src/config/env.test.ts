import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u@db/x',
  API_URL: 'https://api.stackroost.dev',
  WEBSITE_URL: 'https://stackroost.dev',
  SESSION_SECRET: 'x'.repeat(32),
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  PADDLE_ENV: 'production',
  PADDLE_API_KEY: 'pdl_live_apikey_x',
  PADDLE_WEBHOOK_SECRET: 's',
  PADDLE_CLIENT_TOKEN: 'live_x',
  LICENSE_SIGNING_PRIVATE_KEY: 'k',
  LICENSE_SIGNING_PUBLIC_KEY: 'k',
};

describe('loadEnv (production hardening)', () => {
  it('accepts a secure production config and enables the webhook IP allowlist', () => {
    expect(loadEnv(base).PADDLE_WEBHOOK_IP_ALLOWLIST).toBe(true);
  });

  it.each([
    [{ API_URL: 'http://api.stackroost.dev' }, 'API_URL'],
    [{ PADDLE_API_KEY: 'pdl_sdbx_apikey_x' }, 'PADDLE_API_KEY'],
    [{ PADDLE_WEBHOOK_IP_ALLOWLIST: 'false' }, 'PADDLE_WEBHOOK_IP_ALLOWLIST'],
    [{ SESSION_SECRET: 'short' }, 'SESSION_SECRET'],
  ])('refuses %o', (override, key) => {
    expect(() => loadEnv({ ...base, ...override })).toThrow(key);
  });

  it('names every missing variable at once', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL[\s\S]*GOOGLE_CLIENT_ID/,
    );
  });
});
