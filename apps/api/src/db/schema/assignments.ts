import { pgTable, pgEnum, uuid, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { commissionPlans } from './plans';

export const assignmentRoleEnum = pgEnum('assignment_role', [
  'closer',
  'setter',
  'manager',
  'override_recipient',
]);

export const planAssignments = pgTable(
  'plan_assignments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    planId: uuid('plan_id')
      .notNull()
      .references(() => commissionPlans.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: assignmentRoleEnum('role').notNull(),
    defaultSplitPercent: numeric('default_split_percent', { precision: 5, scale: 2 })
      .notNull()
      .default('100.00'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'date' }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('idx_assignments_org_id').on(table.orgId),
    index('idx_assignments_plan_user').on(table.planId, table.userId),
    // Exclusion constraint for overlapping date ranges added manually in migration:
    // EXCLUDE USING gist (plan_id WITH =, user_id WITH =, role WITH =,
    //   tstzrange(effective_from, COALESCE(effective_to, 'infinity'), '[)') WITH &&)
  ]
);
