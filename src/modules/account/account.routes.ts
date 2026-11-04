import { Router, type RequestHandler } from 'express';
import { validate } from '@/shared/http/validate';
import type { AccountController } from './account.controller';
import { removeDeviceSchema } from './account.validation';

/** Every route is for the signed-in owner; ownership is enforced in the services. */
export function accountRoutes(ctrl: AccountController, session: RequestHandler): Router {
  const r = Router();
  r.get('/', session, ctrl.overview);
  r.delete('/devices/:deviceId', session, validate(removeDeviceSchema), ctrl.removeDevice);
  r.post('/license/rotate', session, ctrl.rotateKey);
  return r;
}
