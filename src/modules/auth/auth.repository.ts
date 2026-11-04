import type { Account, Session } from '@/generated/prisma/client';
import type { DbClient } from '@/db/prisma';

export interface AuthRepository {
  createSession(data: {
    tokenHash: string;
    accountId: string;
    expiresAt: Date;
    now: Date;
  }): Promise<Session>;
  /** Valid = before absolute expiry AND used since `idleCutoff`. */
  findActiveSession(
    tokenHash: string,
    now: Date,
    idleCutoff: Date,
  ): Promise<(Session & { account: Account }) | null>;
  touch(id: string, now: Date): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Signs the account out everywhere (role change, compromise). */
  deleteAccountSessions(accountId: string): Promise<number>;
  purgeExpired(now: Date, idleCutoff: Date): Promise<number>;
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly db: DbClient) {}

  createSession({
    tokenHash,
    accountId,
    expiresAt,
    now,
  }: {
    tokenHash: string;
    accountId: string;
    expiresAt: Date;
    now: Date;
  }) {
    return this.db.session.create({ data: { tokenHash, accountId, expiresAt, lastUsedAt: now } });
  }

  findActiveSession(tokenHash: string, now: Date, idleCutoff: Date) {
    return this.db.session.findFirst({
      where: { tokenHash, expiresAt: { gt: now }, lastUsedAt: { gt: idleCutoff } },
      include: { account: true },
    });
  }

  async touch(id: string, now: Date) {
    await this.db.session.updateMany({ where: { id }, data: { lastUsedAt: now } });
  }

  async deleteSession(id: string) {
    await this.db.session.deleteMany({ where: { id } });
  }

  async deleteAccountSessions(accountId: string) {
    return (await this.db.session.deleteMany({ where: { accountId } })).count;
  }

  async purgeExpired(now: Date, idleCutoff: Date) {
    const { count } = await this.db.session.deleteMany({
      where: { OR: [{ expiresAt: { lte: now } }, { lastUsedAt: { lte: idleCutoff } }] },
    });
    return count;
  }
}
