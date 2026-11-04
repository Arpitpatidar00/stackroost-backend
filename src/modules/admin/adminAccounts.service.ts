import type { UnitOfWork } from '@/db/unitOfWork';
import type { Account, Role } from '@/generated/prisma/client';
import type { AuditService, Actor } from '@/modules/audit/audit.service';
import type { AuthService } from '@/modules/auth/auth.service';
import type { BillingService } from '@/modules/billing/billing.service';
import type { LicensesService } from '@/modules/licenses/licenses.service';
import { AppError } from '@/shared/errors/AppError';
import type { PageRequest } from '@/shared/http/pagination';

export const adminAccountView = (a: Account) => ({
  id: a.id,
  email: a.email,
  name: a.name,
  role: a.role,
  lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
  createdAt: a.createdAt.toISOString(),
});

export class AdminAccountsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly billing: BillingService,
    private readonly licenses: LicensesService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async list(filter: { search?: string; role?: Role }, page: PageRequest) {
    const { items, total } = await this.uow.repos.accounts.list(filter, page);
    return { items: items.map(adminAccountView), total };
  }

  async detail(accountId: string) {
    const account = await this.uow.repos.accounts.findById(accountId);
    if (!account) throw AppError.notFound('Account');
    const [billing, license] = await Promise.all([
      this.billing.summary(this.uow.repos, accountId),
      this.licenses.overview(accountId),
    ]);
    return { account: adminAccountView(account), ...billing, license };
  }

  /** Role changes sign the account out everywhere so the new role applies at once. */
  async setRole(actor: Actor, accountId: string, role: Role) {
    if (actor.accountId === accountId && role !== 'admin') {
      throw AppError.conflict('You can’t remove your own admin role.');
    }
    const updated = await this.uow.transaction(async (tx) => {
      if (!(await tx.accounts.findById(accountId))) throw AppError.notFound('Account');
      const account = await tx.accounts.setRole(accountId, role);
      await this.audit.record(
        tx,
        actor,
        'account.set_role',
        { type: 'account', id: accountId },
        { role },
      );
      return account;
    });
    await this.auth.logoutEverywhere(accountId);
    return adminAccountView(updated);
  }

  setLicenseStatus(actor: Actor, accountId: string, status: 'active' | 'revoked') {
    return this.uow.transaction(async (tx) => {
      const license = await this.licenses.setStatus(tx, accountId, status);
      await this.audit.record(
        tx,
        actor,
        status === 'revoked' ? 'license.revoke' : 'license.restore',
        { type: 'license', id: license.id },
        { accountId },
      );
      return { status: license.status };
    });
  }

  async revokeSessions(actor: Actor, accountId: string) {
    const count = await this.auth.logoutEverywhere(accountId);
    await this.uow.transaction((tx) =>
      this.audit.record(
        tx,
        actor,
        'account.revoke_sessions',
        { type: 'account', id: accountId },
        { count },
      ),
    );
    return { revoked: count };
  }
}
