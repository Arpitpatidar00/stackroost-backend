import { z } from 'zod';
import { FEATURE_IDS, MODULE_IDS } from '@/domain/catalog/modules';
import { paginationQuery } from '@/shared/http/pagination';

const id = z.string().min(1).max(64);
const idParam = { params: z.object({ id }) };
const effectiveFrom = z.enum(['immediately', 'next_billing_period']).default('next_billing_period');
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code');

// Admin input rejects unknown keys (.strict): a typo must fail loudly, not be ignored.
const planFields = {
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500).default(''),
  rank: z.number().int().min(1).max(1000),
  modules: z
    .array(z.enum(MODULE_IDS))
    .min(1)
    .transform((m) => [...new Set(m)]),
  features: z
    .array(z.enum(FEATURE_IDS))
    .default([])
    .transform((f) => [...new Set(f)]),
};

export const listAccountsSchema = {
  query: paginationQuery.extend({
    search: z.string().trim().max(100).optional(),
    role: z.enum(['user', 'admin']).optional(),
  }),
};
export const accountIdSchema = idParam;
export const setRoleSchema = {
  ...idParam,
  body: z.object({ role: z.enum(['user', 'admin']) }).strict(),
};

export const createPlanSchema = {
  body: z
    .object({ key: z.string().regex(/^[a-z][a-z0-9-]{1,29}$/, 'lowercase slug'), ...planFields })
    .strict(),
};
export const updatePlanSchema = {
  ...idParam,
  body: z
    .object({
      name: planFields.name.optional(),
      description: z.string().trim().max(500).optional(),
      rank: planFields.rank.optional(),
      modules: planFields.modules.optional(),
      features: z.array(z.enum(FEATURE_IDS)).optional(),
      isActive: z.boolean().optional(),
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, 'nothing to update'),
};
export const createPriceSchema = {
  ...idParam,
  body: z
    .object({
      interval: z.enum(['month', 'year']),
      amountMinor: z.number().int().min(50).max(10_000_000),
      currency,
      trialDays: z.number().int().min(1).max(90).nullable().default(null),
    })
    .strict(),
};
export const setActiveSchema = { ...idParam, body: z.object({ isActive: z.boolean() }).strict() };

export const listCouponsSchema = {
  query: paginationQuery.extend({ active: z.stringbool().optional() }),
};
export const createCouponSchema = {
  body: z
    .object({
      code: z.string().trim().min(3).max(32),
      description: z.string().trim().min(1).max(200),
      type: z.enum(['percentage', 'flat']),
      amount: z.number().int().positive(),
      currency: currency.nullable().default(null),
      recurring: z.boolean().default(false),
      maxRecurringIntervals: z.number().int().min(1).max(120).nullable().default(null),
      usageLimit: z.number().int().min(1).nullable().default(null),
      expiresAt: z.coerce.date().nullable().default(null),
      planIds: z.array(id).max(20).default([]),
    })
    .strict()
    .refine((c) => !c.expiresAt || c.expiresAt > new Date(), {
      path: ['expiresAt'],
      message: 'must be in the future',
    }),
};

export const listSubscriptionsSchema = {
  query: paginationQuery.extend({
    status: z.enum(['active', 'trialing', 'past_due', 'paused', 'canceled']).optional(),
    search: z.string().trim().max(100).optional(),
  }),
};
export const subscriptionIdSchema = {
  params: z.object({ id: z.string().regex(/^sub_[a-z0-9]+$/) }),
};
export const subscriptionActionSchema = {
  ...subscriptionIdSchema,
  body: z.object({ effectiveFrom }).strict(),
};

export const auditLogSchema = {
  query: paginationQuery.extend({
    actorId: id.optional(),
    targetType: z.string().max(40).optional(),
    targetId: id.optional(),
  }),
};
