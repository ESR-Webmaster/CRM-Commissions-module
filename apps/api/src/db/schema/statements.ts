import { pgTable, pgEnum, uuid, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const statementStatusEnum = pgEnum('statement_status', ['draft', 'approved', 'paid']);

export const payoutStatements = pgTable(
  'payout_statements',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'date' }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'date' }).notNull(),
    totalEarned: numeric('total_earned', { precision: 12, scale: 2 }).notNull(),
    totalClawedBack: numeric('total_clawed_back', { precision: 12, scale: 2 }).notNull(),
    totalAdjustments: numeric('total_adjustments', { precision: 12, scale: 2 }).notNull(),
    netPayable: numeric('net_payable', { precision: 12, scale: 2 }).notNull(),
    status: statementStatusEnum('status').notNull().default('draft'),
    approvedBy: uuid('approved_by'),
    eventIds: uuid('event_ids').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_statements_org_id').on(table.orgId),
    index('idx_statements_user').on(table.orgId, table.userId),
  ]
);
