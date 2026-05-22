import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(), // provided from Sunscape — not auto-generated
    orgId: uuid('org_id').notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [index('idx_users_org_id').on(table.orgId)]
);
