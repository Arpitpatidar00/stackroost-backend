/**
 * Seeds the three launch plans (idempotent: upsert by key; existing plans keep
 * their modules unless --force). Prices are NOT created here — they live in
 * Paddle: create them through the admin API (POST /v1/admin/plans/:id/prices),
 * which creates the Paddle product + price and mirrors them.
 *
 *   npm run seed:plans [-- --force]
 */
import { createPrisma } from '../src/db/prisma';

const PLANS = [
  {
    key: 'basic',
    name: 'Basic',
    rank: 1,
    description: 'Local development essentials.',
    modules: ['homebrew', 'ports', 'doctor', 'maclean', 'toolbox', 'claude'],
    features: [],
  },
  {
    key: 'pro',
    name: 'Pro',
    rank: 2,
    description: 'Everything for a full-stack developer.',
    modules: [
      'homebrew',
      'ports',
      'doctor',
      'maclean',
      'toolbox',
      'claude',
      'docker',
      'databases',
      'projects',
      'remote',
      'secrets',
      'domains',
    ],
    features: ['maclean.deep_scan', 'maclean.clean'],
  },
  {
    key: 'max',
    name: 'Max',
    rank: 3,
    description: 'Every module, including cloud, Kafka and devices.',
    modules: [
      'homebrew',
      'ports',
      'doctor',
      'maclean',
      'toolbox',
      'claude',
      'docker',
      'databases',
      'projects',
      'remote',
      'secrets',
      'domains',
      'kafka',
      'cloud',
      'network',
      'devices',
      'releases',
      'backups',
    ],
    features: ['maclean.deep_scan', 'maclean.clean', 'remote.terminal'],
  },
];

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const force = process.argv.includes('--force');
const prisma = createPrisma(url);

for (const plan of PLANS) {
  const { key, ...data } = plan;
  const row = await prisma.plan.upsert({
    where: { key },
    create: plan,
    update: force ? data : {},
  });
  console.log(
    `${row.key.padEnd(6)} rank ${String(row.rank)}  ${String(row.modules.length)} modules  ${row.id}`,
  );
}
await prisma.$disconnect();
