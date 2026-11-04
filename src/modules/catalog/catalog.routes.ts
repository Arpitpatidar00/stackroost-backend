import { Router } from 'express';
import { publicRoute } from '@/middleware/auth';
import { ok } from '@/shared/http/response';
import type { CatalogService } from './catalog.service';

/** Public pricing (website pricing page, app upgrade screen). */
export function catalogRoutes(catalog: CatalogService): Router {
  const r = Router();
  r.get('/', publicRoute('pricing page'), async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    ok(res, await catalog.publicCatalogue());
  });
  return r;
}
