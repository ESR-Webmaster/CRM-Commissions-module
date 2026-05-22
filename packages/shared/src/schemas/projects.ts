import { z } from 'zod';

const repAssignmentSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['closer', 'setter', 'manager', 'override_recipient']),
  split_percent: z.number().min(0.01).max(100).default(100),
});

export const upsertProjectSchema = z.object({
  project_id: z.string().uuid(),
  rep_assignments: z.array(repAssignmentSchema).min(1),
  plan_override_id: z.string().uuid().optional(),
  contract_value: z.number().positive(),
  system_size_kw: z.number().positive(),
});

export const stageTransitionSchema = z.object({
  project_id: z.string().uuid(),
  from_stage: z.string().min(1),
  to_stage: z.string().min(1),
  transition_id: z.string().min(1),
  delivery_id: z.string().min(1).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});
