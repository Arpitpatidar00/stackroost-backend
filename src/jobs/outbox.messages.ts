/** Every side effect the outbox can carry. Typed end to end: enqueue ↔ worker. */
export type OutboxMessage =
  | { type: 'email.license_issued'; payload: { email: string; licenseKey: string } }
  | { type: 'email.license_key_rotated'; payload: { email: string; licenseKey: string } };

export type OutboxMessageType = OutboxMessage['type'];
