import { pgTable, uuid, jsonb, numeric, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { commissionPlans } from './plans';

export interface RepAssignment {
  user_id: string;
  role: 'closer' | 'setter' | 'manager' | 'override_recipient';
  split_percent: number;
}

export const projectCommissionConfigs = pgTable(
  'project_commission_configs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull(),
    orgId: uuid('org_id').notNull(),
    repAssignments: jsonb('rep_assignments').$type<RepAssignment[]>().notNull(),
    planOverrideId: uuid('plan_override_id').references(() => commissionPlans.id),
    contractValue: numeric('contract_value', { precision: 12, scale: 2 }).notNull(),
    systemSizeKw: numeric('system_size_kw', { precision: 8, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('uq_project_commission_configs_project_id').on(table.projectId),
    index('idx_project_configs_org_id').on(table.orgId),
  ]
);
