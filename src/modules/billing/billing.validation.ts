import { z } from 'zod';

const priceId = z.string().regex(/^pri_[a-z0-9]{10,64}$/, 'Paddle price id');
const couponCode = z.string().trim().min(3).max(32);

export const checkoutSchema = {
  body: z.object({ priceId, couponCode: couponCode.optional() }),
};

export const couponPreviewSchema = {
  body: z.object({ priceId, code: couponCode }),
};

export const planChangeSchema = {
  body: z.object({ priceId }),
};
