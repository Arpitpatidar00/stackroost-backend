import { loadEnv } from '@/config/env';
import { buildContainer, createInfrastructure } from '@/container';
import { createApp } from '@/app';

const env = loadEnv();
const infra = createInfrastructure(env);
const app = createApp(buildContainer(env, infra));

const server = app.listen(env.PORT, () => {
  infra.log.info({ port: env.PORT, env: env.NODE_ENV, paddle: env.PADDLE_ENV }, 'api listening');
});
// Paddle needs a 2xx within 5 s; never let a slow socket hold the process.
server.requestTimeout = 15_000;

/** Graceful shutdown: stop accepting, drain in-flight requests, then close the DB. */
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  infra.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => {
    void infra.close().finally(() => {
      clearTimeout(force);
      process.exit(0);
    });
  });
}
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('unhandledRejection', (reason) => {
  infra.log.fatal({ err: reason }, 'unhandled rejection');
  shutdown('unhandledRejection');
});
