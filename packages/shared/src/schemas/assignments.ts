import { z } from 'zod';

export const assignmentRoleEnum = z.enum(['closer', 'setter', 'manager', 'override_recipient']);

export const createAssignmentSchema = z.object({
  plan_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: assignmentRoleEnum,
  default_split_percent: z.number().min(0.01).max(100).optional().default(100),
  effective_from: z.string().datetime({ offset: true }),
  effective_to: z.string().datetime({ offset: true }).optional(),
});

export const listAssignmentsQuerySchema = z.object({
  user_id: z.string().uuid().optional(),
  plan_id: z.string().uuid().optional(),
  is_active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
