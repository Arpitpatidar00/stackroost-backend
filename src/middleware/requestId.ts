import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const HEADER = 'x-request-id';
const SAFE = /^[\w-]{8,64}$/;

/** Correlation id: honour a sane upstream id, otherwise mint one; echo it back. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header(HEADER);
  req.id = incoming && SAFE.test(incoming) ? incoming : randomUUID();
  res.setHeader(HEADER, req.id);
  next();
};
