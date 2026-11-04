import { randomInt } from 'node:crypto';

/** Crockford base32 without I, L, O, U: unambiguous when typed by hand. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 5;
const GROUP_LEN = 5;

/** `SR-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` — 125 bits of entropy. */
export function generateLicenseKey(): string {
  const groups = Array.from({ length: GROUPS }, () =>
    Array.from({ length: GROUP_LEN }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  );
  return `SR-${groups.join('-')}`;
}

/** Canonical form for hashing: upper-case, typo-tolerant, dashes normalised. */
export function normalizeLicenseKey(input: string): string {
  const body = input
    .trim()
    .toUpperCase()
    .replace(/^SR-?/, '')
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  const groups = body.match(new RegExp(`.{1,${GROUP_LEN}}`, 'g')) ?? [];
  return `SR-${groups.join('-')}`;
}

export const isWellFormedLicenseKey = (key: string) =>
  new RegExp(`^SR(-[${ALPHABET}]{${GROUP_LEN}}){${GROUPS}}$`).test(key);

/** Display-safe preview: `SR-7K2Q1…X9PD`. */
export const previewLicenseKey = (key: string) => `${key.slice(0, 8)}…${key.slice(-4)}`;
