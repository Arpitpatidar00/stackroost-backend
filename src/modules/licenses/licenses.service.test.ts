import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, events, PRICES } from '../../../test/fakes/harness';

let h: ReturnType<typeof createHarness>;
let accountId: string;
const device = (n: number) => ({
  deviceId: `device-000000000000000${String(n)}`,
  deviceName: `Mac ${String(n)}`,
  appVersion: '0.2.0',
});

/** A Pro subscriber; returns their plaintext key (from the issuance email). */
async function purchase(priceId: string = PRICES.proMonthly) {
  accountId = (await h.uow.repos.accounts.upsertByEmail('pro@example.com')).id;
  await h.subscribe(accountId, { priceId });
  return h.uow.outboxOf('email.license_issued')[0]!.licenseKey;
}

beforeEach(async () => {
  h = createHarness();
  await h.seedCatalog();
});

describe('activate', () => {
  it('returns a signed token with exactly the plan’s modules, bound to the device', async () => {
    const key = await purchase();
    const res = await h.licenses.activate(key, device(1));
    expect(res).toMatchObject({
      plan: 'pro',
      modules: ['homebrew', 'ports', 'remote'],
      features: [],
    });
    expect(h.container.infra.signer.verify(res.token)).toMatchObject({
      plan: 'pro',
      dev: device(1).deviceId,
    });
  });

  it('Max unlocks Max modules and features', async () => {
    const res = await h.licenses.activate(await purchase(PRICES.maxMonthly), device(1));
    expect(res).toMatchObject({
      plan: 'max',
      modules: expect.arrayContaining(['kafka']),
      features: ['maclean.deep_scan'],
    });
  });

  it('after cancellation the token unlocks nothing (plan null)', async () => {
    const key = await purchase();
    await h.deliver(events.subscription({ status: 'canceled' }, '2026-11-05T00:00:00Z'));
    expect(await h.licenses.activate(key, device(1))).toMatchObject({
      plan: null,
      modules: [],
      features: [],
    });
  });

  it('rejects unknown keys like malformed ones (no enumeration)', async () => {
    await purchase();
    for (const bad of ['SR-00000-00000-00000-00000-00000', 'nonsense-key']) {
      await expect(h.licenses.activate(bad, device(1))).rejects.toMatchObject({
        code: 'LICENSE_INVALID',
      });
    }
  });

  it('enforces the device limit; re-activating a known Mac is free; failures roll back', async () => {
    const key = await purchase();
    await h.licenses.activate(key, device(1));
    await h.licenses.activate(key, device(2));
    await expect(h.licenses.activate(key, device(1))).resolves.toBeDefined();
    await expect(h.licenses.activate(key, device(3))).rejects.toMatchObject({
      code: 'DEVICE_LIMIT_REACHED',
      status: 409,
    });
    expect(h.uow.state.activations.size).toBe(2);
  });

  it('a revoked license cannot activate or refresh', async () => {
    const key = await purchase();
    const { token } = await h.licenses.activate(key, device(1));
    await h.uow.transaction((tx) => h.licenses.setStatus(tx, accountId, 'revoked'));
    await expect(h.licenses.activate(key, device(2))).rejects.toMatchObject({
      code: 'LICENSE_REVOKED',
    });
    await expect(h.licenses.refresh(token, '0.2.0')).rejects.toMatchObject({
      code: 'LICENSE_REVOKED',
    });
  });
});

describe('refresh', () => {
  it('picks up a plan change (Pro → Max) on the next refresh', async () => {
    const { token } = await h.licenses.activate(await purchase(), device(1));
    await h.deliver(events.subscription({ priceId: PRICES.maxMonthly }, '2026-11-03T00:00:00Z'));
    expect((await h.licenses.refresh(token, '0.3.0')).plan).toBe('max');
  });

  it('refuses once the device was removed from the account page', async () => {
    const { token } = await h.licenses.activate(await purchase(), device(1));
    const [activation] = await h.licenses.listDevices(accountId);
    await h.licenses.removeDevice(accountId, activation!.id);
    await expect(h.licenses.refresh(token, '0.2.0')).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    });
  });

  it('refuses a token long past expiry, and forged tokens', async () => {
    const { token } = await h.licenses.activate(await purchase(), device(1));
    h.clock.advanceDays(14 + 31);
    await expect(h.licenses.refresh(token, '0.2.0')).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    });
    await expect(h.licenses.refresh('a.b.c', '0.2.0')).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    });
  });
});

describe('account-side', () => {
  it('only removes devices on the caller’s own license', async () => {
    await h.licenses.activate(await purchase(), device(1));
    const [activation] = [...h.uow.state.activations.values()];
    const stranger = await h.uow.repos.accounts.upsertByEmail('stranger@example.com');
    await expect(h.licenses.removeDevice(stranger.id, activation!.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rotating the key invalidates the old one and emails the new one', async () => {
    const oldKey = await purchase();
    const { licenseKey } = await h.licenses.rotateKey(accountId, 'pro@example.com');
    await expect(h.licenses.activate(oldKey, device(1))).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    });
    await expect(h.licenses.activate(licenseKey, device(1))).resolves.toBeDefined();
    expect(h.uow.outboxOf('email.license_key_rotated')).toEqual([
      { email: 'pro@example.com', licenseKey },
    ]);
  });

  it('overview never exposes the key', async () => {
    await purchase();
    const overview = await h.licenses.overview(accountId);
    expect(JSON.stringify(overview)).not.toMatch(/SR(-[0-9A-Z]{5}){5}/);
  });
});
