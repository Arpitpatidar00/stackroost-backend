import { z } from 'zod';

export const removeDeviceSchema = {
  params: z.object({ deviceId: z.string().min(1).max(64) }),
};
