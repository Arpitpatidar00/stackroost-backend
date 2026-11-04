import type { Account, Role } from '@/generated/prisma/client';
import type { DbClient } from '@/db/prisma';
import { skipTake, type Page, type PageRequest } from '@/shared/http/pagination';

export interface GoogleIdentityUpsert {
  googleSub: string;
  email: string;
  name: string | null;
  /** Bootstrap admins (ADMIN_EMAILS) are promoted; nobody is demoted here. */
  promoteToAdmin: boolean;
  now: Date;
}

export interface AccountsRepository {
  findById(id: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  /** Race-safe get-or-create on the unique email (purchases before registration). */
  upsertByEmail(email: string): Promise<Account>;
  /**
   * Sign-in: match by Google subject, else adopt an account created by a
   * purchase with the same verified email, else create.
   */
  upsertGoogleIdentity(input: GoogleIdentityUpsert): Promise<Account>;
  list(filter: { search?: string; role?: Role }, page: PageRequest): Promise<Page<Account>>;
  setRole(id: string, role: Role): Promise<Account>;
}

export class PrismaAccountsRepository implements AccountsRepository {
  constructor(private readonly db: DbClient) {}

  findById(id: string) {
    return this.db.account.findUnique({ where: { id } });
  }

  findByEmail(email: string) {
    return this.db.account.findUnique({ where: { email } });
  }

  upsertByEmail(email: string) {
    return this.db.account.upsert({ where: { email }, create: { email }, update: {} });
  }

  async upsertGoogleIdentity({
    googleSub,
    email,
    name,
    promoteToAdmin,
    now,
  }: GoogleIdentityUpsert) {
    const login = {
      email,
      name,
      lastLoginAt: now,
      ...(promoteToAdmin && { role: 'admin' as const }),
    };
    const bySub = await this.db.account.findUnique({ where: { googleSub } });
    if (bySub) return this.db.account.update({ where: { id: bySub.id }, data: login });
    return this.db.account.upsert({
      where: { email },
      create: { googleSub, ...login },
      update: { googleSub, ...login },
    });
  }

  async list(filter: { search?: string; role?: Role }, page: PageRequest) {
    const where = {
      ...(filter.role && { role: filter.role }),
      ...(filter.search && {
        OR: [
          { email: { contains: filter.search, mode: 'insensitive' as const } },
          { name: { contains: filter.search, mode: 'insensitive' as const } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.db.account.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(page) }),
      this.db.account.count({ where }),
    ]);
    return { items, total };
  }

  setRole(id: string, role: Role) {
    return this.db.account.update({ where: { id }, data: { role } });
  }
}
