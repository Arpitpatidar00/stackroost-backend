import type { Logger } from '@/shared/logger';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Port for transactional email. Only the outbox worker calls it (after commit). */
export interface Mailer {
  send(email: Email): Promise<void>;
}

/**
 * Development/test mailer: logs instead of sending (bodies included, since
 * they carry magic links you need locally). Swap for a provider adapter
 * (Resend, Postmark, SES) in production via the composition root.
 */
export class LogMailer implements Mailer {
  constructor(private readonly log: Logger) {}

  send(email: Email): Promise<void> {
    this.log.info(
      { mail: { to: '[redacted]', subject: email.subject } },
      'email (not sent: LogMailer)',
    );
    this.log.debug({ body: email.text }, 'email body');
    return Promise.resolve();
  }
}
