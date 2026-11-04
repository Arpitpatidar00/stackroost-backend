import { describe, expect, it } from 'vitest';
import { PaddleIpAllowlist } from './paddle.ips';

const response = (cidrs: unknown, ok = true) =>
  Promise.resolve({
    ok,
    status: ok ? 200 : 503,
    json: () => Promise.resolve({ data: { ipv4_cidrs: cidrs } }),
  } as Response);

describe('PaddleIpAllowlist', () => {
  it('allows only listed /32 hosts (incl. IPv4-mapped IPv6 form)', async () => {
    const list = new PaddleIpAllowlist('production', () =>
      response(['34.232.58.13/32', '10.0.0.0/8']),
    );
    expect(await list.allows('34.232.58.13')).toBe(true);
    expect(await list.allows('::ffff:34.232.58.13')).toBe(true);
    expect(await list.allows('10.1.2.3')).toBe(false); // wide ranges are never trusted
    expect(await list.allows('1.2.3.4')).toBe(false);
  });

  it('caches for an hour, then refreshes', async () => {
    let calls = 0;
    let t = 0;
    const list = new PaddleIpAllowlist(
      'sandbox',
      () => (calls++, response(['1.1.1.1/32'])),
      () => t,
    );
    await list.allows('1.1.1.1');
    await list.allows('1.1.1.1');
    expect(calls).toBe(1);
    t = 61 * 60 * 1000;
    await list.allows('1.1.1.1');
    expect(calls).toBe(2);
  });

  it('keeps the last good list when a refresh fails', async () => {
    let t = 0;
    let fail = false;
    const list = new PaddleIpAllowlist(
      'production',
      () => (fail ? response([], false) : response(['1.1.1.1/32'])),
      () => t,
    );
    expect(await list.allows('1.1.1.1')).toBe(true);
    fail = true;
    t = 2 * 60 * 60 * 1000;
    expect(await list.allows('1.1.1.1')).toBe(true);
  });

  it('fails closed when it has never loaded a list', async () => {
    const list = new PaddleIpAllowlist('production', () => response([], false));
    await expect(list.allows('1.1.1.1')).rejects.toThrow();
  });
});
