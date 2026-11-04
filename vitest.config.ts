import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Real-Postgres suite runs separately (npm run test:integration).
    exclude: ['test/integration/**', 'node_modules/**'],
    // Unit + route tests need no database: services run on in-memory repositories.
    env: { NODE_ENV: 'test' },
  },
});
