import { z } from 'zod';

const device = {
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'opaque device id'),
  deviceName: z.string().trim().min(1).max(80),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+([-+][\w.-]+)?$/, 'semver'),
};

export const activateSchema = {
  body: z.object({ licenseKey: z.string().min(10).max(64), ...device }),
};

export const refreshSchema = {
  body: z.object({ token: z.string().min(20).max(4096), appVersion: device.appVersion }),
};

export const deactivateSchema = {
  body: z.object({ licenseKey: z.string().min(10).max(64), deviceId: device.deviceId }),
};
