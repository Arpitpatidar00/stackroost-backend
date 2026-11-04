import 'express-serve-static-core';
import type { SessionPrincipal } from '@/modules/auth/auth.service';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlation id (middleware/requestId). */
    id: string;
    /** Output of `validate(...)`: stripped, coerced input. */
    validated?: { body?: unknown; params?: unknown; query?: unknown };
    /** Set by `requireSession` on authenticated website routes. */
    auth?: SessionPrincipal;
  }
}
