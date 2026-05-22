import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DocusealMode = 'saas' | 'self_hosted';

export type DocusealTemplateCategory =
  | 'proposal'
  | 'install_agreement'
  | 'change_order'
  | 'consent'
  | 'disclosure'
  | 'other';

export type DocusealSubmissionStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'partially_signed'
  | 'signed'
  | 'declined'
  | 'voided'
  | 'expired';

export type DocusealSubmitterStatus = 'pending' | 'viewed' | 'signed' | 'declined';

export interface DocusealSignerRole {
  name: string;
  order: number;
}

export interface DocusealConfigDefaults {
  reminderCadence?: 'off' | '48h_96h' | 'daily';
  expirationDays?: number;
  deliveryChannel?: 'email' | 'sms' | 'both';
}

// ── docuseal_config ───────────────────────────────────────────────────────────

export const docusealConfig = pgTable(
  'docuseal_config',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid('org_id').notNull(),
    mode: text('mode').notNull().$type<DocusealMode>(),
    endpointUrl: text('endpoint_url').notNull(),
    // Stored at rest in DB; production should add column-level encryption
    apiToken: text('api_token').notNull(),
    webhookSecret: text('webhook_secret').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    defaults: jsonb('defaults')
      .$type<DocusealConfigDefaults>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastHealthAt: timestamp('last_health_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    // Partial index: only one active config per org allowed
    uniqueIndex('uq_docuseal_config_org_active')
      .on(table.orgId)
      .where(sql`${table.isActive} = true`),
    index('idx_docuseal_config_org_id').on(table.orgId),
  ]
);

// ── docuseal_templates ────────────────────────────────────────────────────────

export const docusealTemplates = pgTable(
  'docuseal_templates',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid('org_id').notNull(),
    docusealId: text('docuseal_id').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull().$type<DocusealTemplateCategory>(),
    version: integer('version').notNull().default(1),
    parentId: uuid('parent_id'),
    mergeFields: jsonb('merge_fields').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    signerRoles: jsonb('signer_roles')
      .$type<DocusealSignerRole[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_docuseal_templates_org_category').on(table.orgId, table.category),
  ]
);

// ── docuseal_submissions ──────────────────────────────────────────────────────

export interface DocusealSubmissionMetadata {
  mergeValues?: Record<string, string>;
  customMessage?: string;
  deliveryChannel?: 'email' | 'sms' | 'both';
  orchestrationWorkflowId?: string;
  orchestrationExecutionId?: string;
  bulkJobId?: string;
}

export const docusealSubmissions = pgTable(
  'docuseal_submissions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id'),
    templateId: uuid('template_id').notNull(),
    docusealId: text('docuseal_id').notNull(),
    status: text('status').notNull().$type<DocusealSubmissionStatus>(),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    signedPdfUrl: text('signed_pdf_url'),
    voidReason: text('void_reason'),
    declineReason: text('decline_reason'),
    metadata: jsonb('metadata')
      .$type<DocusealSubmissionMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_docuseal_submissions_org_status').on(table.orgId, table.status),
    index('idx_docuseal_submissions_project').on(table.projectId),
    index('idx_docuseal_submissions_template').on(table.templateId),
  ]
);

// ── docuseal_submitters ───────────────────────────────────────────────────────

export const docusealSubmitters = pgTable(
  'docuseal_submitters',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    submissionId: uuid('submission_id').notNull(),
    role: text('role').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    order: integer('order').notNull().default(1),
    status: text('status').notNull().$type<DocusealSubmitterStatus>(),
    signedAt: timestamp('signed_at', { withTimezone: true, mode: 'date' }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [index('idx_docuseal_submitters_submission').on(table.submissionId)]
);

// ── docuseal_workflow_triggers ────────────────────────────────────────────────
// Stores active workflow trigger/action pairs per org.
// When a DocuSeal event fires and matches a trigger, the associated action runs.

export type DocusealTriggerType =
  | 'docuseal.document.signed'
  | 'docuseal.document.declined'
  | 'docuseal.document.expired';

export type DocusealActionType =
  | 'update_project_status'
  | 'create_task'
  | 'send_notification'
  | 'send_for_signature';

export interface DocusealTriggerFilter {
  templateCategory?: string;
  templateId?: string;
}

export interface DocusealActionConfig {
  projectStatus?: string;
  taskTitle?: string;
  notificationMessage?: string;
  templateId?: string;
  signerMapping?: Record<string, string>;
}

export const docusealWorkflowTriggers = pgTable(
  'docuseal_workflow_triggers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid('org_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    triggerType: text('trigger_type').notNull().$type<DocusealTriggerType>(),
    filterConfig: jsonb('filter_config')
      .$type<DocusealTriggerFilter>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    actionType: text('action_type').notNull().$type<DocusealActionType>(),
    actionConfig: jsonb('action_config')
      .$type<DocusealActionConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    prebuiltKey: text('prebuilt_key'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_docuseal_workflow_triggers_org').on(table.orgId, table.isActive),
  ]
);

// ── docuseal_audit ────────────────────────────────────────────────────────────
// Append-only — no application UPDATE or DELETE on this table.

export const docusealAudit = pgTable(
  'docuseal_audit',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    submissionId: uuid('submission_id').notNull(),
    eventType: text('event_type').notNull(),
    eventPayload: jsonb('event_payload').notNull().default(sql`'{}'::jsonb`),
    // Idempotency key — unique constraint prevents double-processing the same DocuSeal event
    docusealEventId: text('docuseal_event_id').unique(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_docuseal_audit_submission').on(table.submissionId, table.receivedAt),
  ]
);
