import { pgTable, pgEnum, uuid, text, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { commissionEvents } from './events';

export const adjustmentReasonEnum = pgEnum('adjustment_reason', [
  'redesign',
  'change_order',
  'bonus',
  'penalty',
  'manual',
]);

export const commissionAdjustments = pgTable(
  'commission_adjustments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    reason: adjustmentReasonEnum('reason').notNull(),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    commissionEventId: uuid('commission_event_id').references(() => commissionEvents.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_adjustments_org_id').on(table.orgId),
    index('idx_adjustments_project_user').on(table.projectId, table.userId),
  ]
);
