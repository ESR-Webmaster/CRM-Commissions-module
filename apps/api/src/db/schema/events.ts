import {
  pgTable,
  pgEnum,
  uuid,
  text,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const eventTypeEnum = pgEnum('event_type', [
  'earned',
  'adjusted',
  'clawed_back',
  'override_earned',
  'adder',
  'deduction',
]);

export const eventStatusEnum = pgEnum('event_status', [
  'pending',
  'approved',
  'paid',
  'disputed',
]);

export const commissionEvents = pgTable(
  'commission_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id').notNull(),
    planId: uuid('plan_id').notNull(),
    eventType: eventTypeEnum('event_type').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    triggeringStageTransitionId: text('triggering_stage_transition_id'),
    deliveryId: text('delivery_id'),
    status: eventStatusEnum('status').notNull().default('pending'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    createdBy: uuid('created_by').notNull(),
  },
  (table) => [
    index('idx_events_org_id').on(table.orgId),
    index('idx_events_dashboard').on(table.orgId, table.userId, table.createdAt),
    index('idx_events_project').on(table.projectId, table.eventType),
    // Unique for idempotency — NULLs in triggeringStageTransitionId don't collide (Postgres NULL semantics)
    uniqueIndex('uq_events_idempotency').on(
      table.triggeringStageTransitionId,
      table.userId,
      table.eventType
    ),
    // Immutability trigger added manually in migration (BEFORE UPDATE fires prevent_commission_event_update())
  ]
);
