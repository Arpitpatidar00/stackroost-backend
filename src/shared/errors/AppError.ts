/** Stable, machine-readable error codes the clients (website, app) switch on. */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'REAUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'CSRF_REJECTED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'LICENSE_INVALID'
  | 'LICENSE_REVOKED'
  | 'DEVICE_LIMIT_REACHED'
  | 'NO_SUBSCRIPTION'
  | 'ALREADY_SUBSCRIBED'
  | 'PLAN_CHANGE_INVALID'
  | 'COUPON_INVALID'
  | 'PLAN_UNAVAILABLE'
  | 'WEBHOOK_REJECTED'
  | 'UPSTREAM_FAILED'
  | 'INTERNAL';

/**
 * The one error type services throw. Carries an HTTP status for the error
 * handler, but services never touch req/res — they only describe the failure.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static validation = (details: unknown) =>
    new AppError('VALIDATION_FAILED', 'Request validation failed.', 400, details);
  static unauthenticated = (message = 'Sign in to continue.') =>
    new AppError('UNAUTHENTICATED', message, 401);
  static notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found.`, 404);
  static forbidden = (message = 'You do not have access to this.') =>
    new AppError('FORBIDDEN', message, 403);
  static conflict = (message: string, details?: unknown) =>
    new AppError('CONFLICT', message, 409, details);
}
