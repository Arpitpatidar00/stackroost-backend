import type { UnitOfWork } from '@/db/unitOfWork';
import type { BillingService } from '@/modules/billing/billing.service';
import type { LicensesService } from '@/modules/licenses/licenses.service';

/** Website account page (backend-for-frontend): composes billing + licensing. */
export class AccountService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly billing: BillingService,
    private readonly licenses: LicensesService,
  ) {}

  async overview(accountId: string, email: string) {
    const [billing, license] = await Promise.all([
      this.billing.summary(this.uow.repos, accountId),
      this.licenses.overview(accountId),
    ]);
    return { email, ...billing, license };
  }

  removeDevice(accountId: string, deviceId: string) {
    return this.licenses.removeDevice(accountId, deviceId);
  }

  rotateLicenseKey(accountId: string, email: string) {
    return this.licenses.rotateKey(accountId, email);
  }
}
