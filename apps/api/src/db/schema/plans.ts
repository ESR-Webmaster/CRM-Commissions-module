import {
  pgTable,
  pgEnum,
  uuid,
  text,
  jsonb,
  timestamp,
  boolean,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const calculationTypeEnum = pgEnum('calculation_type', [
  'percent_contract',
  'ppw',
  'tiered',
  'hybrid',
]);

export interface PayableTrigger {
  type: 'stage' | 'days_after_earned' | 'manual_approval';
  value: string | number;
}

export interface ClawbackConfig {
  enabled: boolean;
  cancellation_stages: string[];
  clawback_percent: number;
  grace_period_days: number;
}

export interface CommissionRules {
  percent?: number;
  dollars_per_watt?: number;
  tiers?: Array<{ min_kw: number; max_kw: number | null; rate: number }>;
}

export const commissionPlans = pgTable(
  'commission_plans',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid('org_id').notNull(),
    name: text('name').notNull(),
    calculationType: calculationTypeEnum('calculation_type').notNull(),
    rules: jsonb('rules').$type<CommissionRules>().notNull(),
    earnedTriggerStage: text('earned_trigger_stage').notNull(),
    payableTrigger: jsonb('payable_trigger').$type<PayableTrigger>().notNull(),
    clawbackConfig: jsonb('clawback_config').$type<ClawbackConfig>(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'date' }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true, mode: 'date' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_plans_org_id').on(table.orgId),
    uniqueIndex('idx_plans_active_name')
      .on(table.orgId, table.name)
      .where(sql`${table.isActive} = true`),
  ]
);
