import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit URL-safe random token (magic links, sessions). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Secrets are stored only as SHA-256 hashes; lookups hash the presented value. */
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
