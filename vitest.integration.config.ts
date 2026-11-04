import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Real-Postgres suite: `DATABASE_URL_TEST=… npm run test:integration` (migrated, disposable DB). */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.int.test.ts'],
    fileParallelism: false, // one shared database
    env: { NODE_ENV: 'test' },
  },
});
