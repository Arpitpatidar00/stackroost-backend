import type { Request, Response } from 'express';
import { principal } from '@/middleware/auth';
import { noContent, ok } from '@/shared/http/response';
import { input } from '@/shared/http/validate';
import type { AccountService } from './account.service';
import { removeDeviceSchema } from './account.validation';

export class AccountController {
  constructor(private readonly account: AccountService) {}

  overview = async (req: Request, res: Response) => {
    const { accountId, email } = principal(req);
    ok(res, await this.account.overview(accountId, email));
  };

  removeDevice = async (req: Request, res: Response) => {
    const { params } = input(req, removeDeviceSchema);
    await this.account.removeDevice(principal(req).accountId, params.deviceId);
    noContent(res);
  };

  rotateKey = async (req: Request, res: Response) => {
    const { accountId, email } = principal(req);
    // Shown once here (no-store) and emailed; never retrievable again.
    ok(res, await this.account.rotateLicenseKey(accountId, email));
  };
}
