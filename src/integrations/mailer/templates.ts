import type { Email } from './mailer';
import type { OutboxMessage } from '@/jobs/outbox.messages';

/** Outbox message → email. Plain text: deliverable, accessible, no tracking. */
export function renderEmail(message: OutboxMessage): Email {
  switch (message.type) {
    case 'email.license_issued':
      return {
        to: message.payload.email,
        subject: 'Your Stackroost license',
        text: `Thanks for subscribing to Stackroost!\n\nYour license key:\n\n    ${message.payload.licenseKey}\n\nOpen Stackroost → Settings → License and paste it to activate. Keep it private.`,
      };
    case 'email.license_key_rotated':
      return {
        to: message.payload.email,
        subject: 'Your new Stackroost license key',
        text: `Your Stackroost license key was replaced. The old key no longer activates new Macs.\n\nNew key:\n\n    ${message.payload.licenseKey}`,
      };
  }
}
