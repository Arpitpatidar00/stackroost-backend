import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logs. Secrets and PII-bearing headers are redacted at source. */
export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["paddle-signature"]',
        '*.licenseKey',
        '*.token',
        '*.email',
      ],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}
