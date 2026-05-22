import { pgTable, uuid, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const overrideRules = pgTable(
  'override_rules',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid('org_id').notNull(),
    managerUserId: uuid('manager_user_id').notNull(),
    teamMemberUserIds: uuid('team_member_user_ids').array().notNull(),
    overridePercent: numeric('override_percent', { precision: 5, scale: 2 }).notNull(),
    appliesToPlanIds: uuid('applies_to_plan_ids').array(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'date' }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('idx_override_rules_org_id').on(table.orgId),
    index('idx_override_rules_manager').on(table.orgId, table.managerUserId),
  ]
);
