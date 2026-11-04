/**
 * Paddle's published webhook source IPs (`GET {api}/ips` → data.ipv4_cidrs,
 * /32s). Fetched, never hard-coded: the endpoint is the source of truth.
 * Cached for an hour; on a failed refresh the last good list is kept.
 */
export interface IpAllowlist {
  allows(ip: string): Promise<boolean>;
}

const TTL_MS = 60 * 60 * 1000;

/** "::ffff:1.2.3.4" (IPv4-mapped IPv6, as Node reports it) → "1.2.3.4". */
export const normalizeIp = (ip: string) => ip.replace(/^::ffff:/, '');

export class PaddleIpAllowlist implements IpAllowlist {
  private cache: { ips: Set<string>; fetchedAt: number } | null = null;
  private inflight: Promise<Set<string>> | null = null;

  constructor(
    private readonly environment: 'sandbox' | 'production',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async allows(ip: string): Promise<boolean> {
    const ips = await this.current();
    return ips.has(normalizeIp(ip));
  }

  private async current(): Promise<Set<string>> {
    if (this.cache && this.now() - this.cache.fetchedAt < TTL_MS) return this.cache.ips;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    try {
      return await this.inflight;
    } catch (e) {
      if (this.cache) return this.cache.ips; // stale beats down
      throw e; // no list at all → caller rejects (fail closed; Paddle retries)
    }
  }

  private async refresh(): Promise<Set<string>> {
    const base =
      this.environment === 'production'
        ? 'https://api.paddle.com'
        : 'https://sandbox-api.paddle.com';
    const res = await this.fetchImpl(`${base}/ips`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`paddle ips: HTTP ${String(res.status)}`);
    const body = (await res.json()) as { data?: { ipv4_cidrs?: unknown } };
    const cidrs = body.data?.ipv4_cidrs;
    if (!Array.isArray(cidrs) || cidrs.length === 0) throw new Error('paddle ips: empty list');
    const ips = new Set(
      cidrs
        .filter((c): c is string => typeof c === 'string')
        // Paddle publishes single hosts as /32; anything wider is ignored, not trusted.
        .filter((c) => !c.includes('/') || c.endsWith('/32'))
        .map((c) => c.replace(/\/32$/, '')),
    );
    this.cache = { ips, fetchedAt: this.now() };
    return ips;
  }
}
