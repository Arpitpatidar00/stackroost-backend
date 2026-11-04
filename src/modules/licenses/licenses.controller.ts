import type { Request, Response } from 'express';
import { noContent, ok } from '@/shared/http/response';
import { input } from '@/shared/http/validate';
import type { LicensesService } from './licenses.service';
import { activateSchema, deactivateSchema, refreshSchema } from './licenses.validation';

/** Endpoints the desktop app calls. Auth = the license key / signed token itself. */
export class LicensesController {
  constructor(private readonly licenses: LicensesService) {}

  activate = async (req: Request, res: Response) => {
    const { body } = input(req, activateSchema);
    const { licenseKey, ...device } = body;
    ok(res, await this.licenses.activate(licenseKey, device));
  };

  refresh = async (req: Request, res: Response) => {
    const { body } = input(req, refreshSchema);
    ok(res, await this.licenses.refresh(body.token, body.appVersion));
  };

  deactivate = async (req: Request, res: Response) => {
    const { body } = input(req, deactivateSchema);
    await this.licenses.deactivate(body.licenseKey, body.deviceId);
    noContent(res);
  };

  publicKeys = (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(this.licenses.publicKeys());
  };
}
