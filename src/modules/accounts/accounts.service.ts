import type { Repositories } from '@/db/unitOfWork';

/** Canonical email form used everywhere an account is looked up. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export class AccountsService {
  /** Get-or-create inside the caller's transaction. */
  findOrCreateByEmail(tx: Repositories, email: string) {
    return tx.accounts.upsertByEmail(normalizeEmail(email));
  }
}
