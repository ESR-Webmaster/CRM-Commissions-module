import { z } from 'zod';

const payableTriggerSchema = z.object({
  type: z.enum(['stage', 'days_after_earned', 'manual_approval']),
  value: z.union([z.string(), z.number()]),
});

const clawbackConfigSchema = z.object({
  enabled: z.boolean(),
  cancellation_stages: z.array(z.string()).min(1),
  clawback_percent: z.number().min(0).max(100),
  grace_period_days: z.number().int().min(0),
});

const basePlanFields = z.object({
  name: z.string().min(1).max(255),
  earned_trigger_stage: z.string().min(1),
  payable_trigger: payableTriggerSchema,
  clawback_config: clawbackConfigSchema.nullable().optional(),
  effective_from: z.string().datetime(),
  effective_to: z.string().datetime().nullable().optional(),
  is_active: z.boolean().optional(),
});

const percentContractCreateSchema = basePlanFields.extend({
  calculation_type: z.literal('percent_contract'),
  rules: z.object({ percent: z.number().min(0.01).max(100) }),
});

const ppwCreateSchema = basePlanFields.extend({
  calculation_type: z.literal('ppw'),
  rules: z.object({ dollars_per_watt: z.number().min(0.001).max(50) }),
});

export const createPlanSchema = z.discriminatedUnion('calculation_type', [
  percentContractCreateSchema,
  ppwCreateSchema,
]);

export type CreatePlanInput = z.infer<typeof createPlanSchema>;

// For PUT — all fields optional except the discriminator when rules change
const percentContractUpdateSchema = basePlanFields.partial().extend({
  calculation_type: z.literal('percent_contract'),
  rules: z.object({ percent: z.number().min(0.01).max(100) }).optional(),
});

const ppwUpdateSchema = basePlanFields.partial().extend({
  calculation_type: z.literal('ppw'),
  rules: z.object({ dollars_per_watt: z.number().min(0.001).max(50) }).optional(),
});

const uncategorizedUpdateSchema = basePlanFields.partial().extend({
  calculation_type: z.undefined().optional(),
  rules: z.undefined().optional(),
});

export const updatePlanSchema = z.union([
  percentContractUpdateSchema,
  ppwUpdateSchema,
  uncategorizedUpdateSchema,
]);

export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

// For end-and-replace — all fields optional (inherited from old plan)
const percentContractReplaceSchema = basePlanFields.partial().extend({
  calculation_type: z.literal('percent_contract').optional(),
  rules: z.object({ percent: z.number().min(0.01).max(100) }).optional(),
  end_date: z.string().datetime().optional(),
});

const ppwReplaceSchema = basePlanFields.partial().extend({
  calculation_type: z.literal('ppw').optional(),
  rules: z.object({ dollars_per_watt: z.number().min(0.001).max(50) }).optional(),
  end_date: z.string().datetime().optional(),
});

export const endAndReplaceSchema = z.union([
  percentContractReplaceSchema,
  ppwReplaceSchema,
  basePlanFields.partial().extend({ end_date: z.string().datetime().optional() }),
]);

export type EndAndReplaceInput = z.infer<typeof endAndReplaceSchema>;

export const listPlansQuerySchema = z.object({
  is_active: z.enum(['true', 'false']).optional(),
  calculation_type: z.enum(['percent_contract', 'ppw', 'tiered', 'hybrid']).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type ListPlansQuery = z.infer<typeof listPlansQuerySchema>;
