import type { Response } from 'express';

/** The single success envelope: `{ success: true, data, meta? }`. */
export function ok(res: Response, data: unknown, status = 200, meta?: Record<string, unknown>) {
  res.status(status).json(meta ? { success: true, data, meta } : { success: true, data });
}

export function noContent(res: Response) {
  res.status(204).end();
}
