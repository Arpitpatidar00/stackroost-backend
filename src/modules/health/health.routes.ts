import { Router } from 'express';
import { publicRoute } from '@/middleware/auth';
import { ok } from '@/shared/http/response';

/** Liveness (process up) vs readiness (dependencies reachable) — for the load balancer. */
export function healthRoutes(checkDatabase: () => Promise<void>): Router {
  const r = Router();
  r.get('/live', publicRoute('probe'), (_req, res) => {
    ok(res, { status: 'ok' });
  });
  r.get('/ready', publicRoute('probe'), async (_req, res) => {
    await checkDatabase();
    ok(res, { status: 'ready' });
  });
  return r;
}
