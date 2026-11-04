/**
 * Generates the Ed25519 keypair that signs license tokens.
 *   npm run keys:generate
 * Paste the output into your secret store (never commit it). Ship the PUBLIC
 * key inside the desktop app; rotate by adding a new key id (LICENSE_SIGNING_KEY_ID).
 */
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const oneLine = (pem: string) => pem.trim().replace(/\n/g, '\\n');

console.log(
  `LICENSE_SIGNING_PRIVATE_KEY="${oneLine(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())}"`,
);
console.log(
  `LICENSE_SIGNING_PUBLIC_KEY="${oneLine(publicKey.export({ format: 'pem', type: 'spki' }).toString())}"`,
);
