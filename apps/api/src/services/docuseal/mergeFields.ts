import { eq, and, inArray } from 'drizzle-orm';
import type { Db } from '../../db/index';
import { projectCommissionConfigs } from '../../db/schema/projects';
import { users } from '../../db/schema/users';
import { orgs } from '../../db/schema/orgs';

// ── Field registry ────────────────────────────────────────────────────────────
// Each entry describes one merge field: where its value comes from and how to
// resolve it. Fields with source='db' are auto-resolved; source='override'
// must be supplied by the caller in the overrides map.

type FieldSource = 'db' | 'override';

interface FieldDef {
  source: FieldSource;
  description: string;
}

export const MERGE_FIELD_REGISTRY: Record<string, FieldDef> = {
  // Customer — must come from caller (not in this DB)
  customer_name:    { source: 'override', description: 'Primary contact full name' },
  customer_email:   { source: 'override', description: 'Primary contact email' },
  customer_phone:   { source: 'override', description: 'Primary contact phone' },
  customer_address: { source: 'override', description: 'Customer mailing address' },

  // Project — must come from caller
  project_id:      { source: 'override', description: 'Sunscape project ID' },
  project_address: { source: 'override', description: 'Install site street address' },
  project_city:    { source: 'override', description: 'Install site city' },
  project_state:   { source: 'override', description: 'Install site state (2-letter)' },
  project_zip:     { source: 'override', description: 'Install site ZIP code' },
  project_county:  { source: 'override', description: 'Install site county' },

  // System — must come from caller (except system_size_kw which we have)
  system_size_kw:                   { source: 'db',       description: 'System size in kW' },
  module_count:                     { source: 'override', description: 'Number of solar modules' },
  module_make_model:                { source: 'override', description: 'Module make and model' },
  inverter_make_model:              { source: 'override', description: 'Inverter make and model' },
  battery_make_model:               { source: 'override', description: 'Battery make and model (if applicable)' },
  estimated_annual_production_kwh:  { source: 'override', description: 'Estimated annual production in kWh' },

  // Financial — resolved from project_commission_configs
  contract_amount:     { source: 'db',       description: 'Total contract value' },
  down_payment:        { source: 'override', description: 'Down payment amount' },
  monthly_payment:     { source: 'override', description: 'Monthly payment amount' },
  financing_term_months: { source: 'override', description: 'Financing term in months' },
  financing_apr:       { source: 'override', description: 'Financing APR (e.g. 5.99%)' },

  // Org / rep — resolved from DB
  installer_company_name:  { source: 'db',       description: 'Installing company name' },
  installer_license_number: { source: 'override', description: 'Contractor license number' },
  sales_rep_name:           { source: 'db',       description: 'Assigned sales rep full name' },
  sales_rep_email:          { source: 'db',       description: 'Assigned sales rep email' },

  // Dates — resolved at call time
  today:           { source: 'db', description: 'Today\'s date (MM/DD/YYYY)' },
  today_long_form: { source: 'db', description: 'Today\'s date (Month DD, YYYY)' },
};

// ── Resolver ──────────────────────────────────────────────────────────────────

export interface ResolveResult {
  values: Record<string, string>;
  warnings: Array<{ field: string; reason: string }>;
}

export async function resolveMergeFields(opts: {
  db: Db;
  orgId: string;
  projectId: string | null | undefined;
  requestedFields: string[];
  overrides: Record<string, string> | undefined;
}): Promise<ResolveResult> {
  const { db, orgId, projectId, requestedFields, overrides = {} } = opts;
  const values: Record<string, string> = {};
  const warnings: Array<{ field: string; reason: string }> = [];

  // Prefetch DB data we might need
  const [orgRow, projectRow] = await Promise.all([
    db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1),
    projectId
      ? db
          .select()
          .from(projectCommissionConfigs)
          .where(and(eq(projectCommissionConfigs.projectId, projectId), eq(projectCommissionConfigs.orgId, orgId)))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const org = orgRow[0];
  const project = (projectRow as (typeof projectCommissionConfigs.$inferSelect)[])[0];

  // Resolve rep info if we have the project
  let closerUser: { name: string; email: string } | undefined;
  if (project) {
    const closerAssignment = project.repAssignments.find((r) => r.role === 'closer');
    if (closerAssignment) {
      const repRows = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, [closerAssignment.user_id]))
        .limit(1);
      closerUser = repRows[0];
    }
  }

  const now = new Date();

  for (const field of requestedFields) {
    // Caller override always wins
    if (overrides[field] !== undefined) {
      values[field] = overrides[field]!;
      continue;
    }

    const def = MERGE_FIELD_REGISTRY[field];
    if (!def) {
      warnings.push({ field, reason: 'Unknown merge field — not in registry' });
      values[field] = '';
      continue;
    }

    if (def.source === 'override') {
      warnings.push({ field, reason: `No value provided for "${field}" — field must be supplied by the sender` });
      values[field] = '';
      continue;
    }

    // DB-resolved fields
    switch (field) {
      case 'system_size_kw':
        if (project) {
          values[field] = formatNumber(project.systemSizeKw);
        } else {
          warnings.push({ field, reason: 'No project found — cannot resolve system_size_kw' });
          values[field] = '';
        }
        break;

      case 'contract_amount':
        if (project) {
          values[field] = formatCurrency(project.contractValue);
        } else {
          warnings.push({ field, reason: 'No project found — cannot resolve contract_amount' });
          values[field] = '';
        }
        break;

      case 'installer_company_name':
        values[field] = org?.name ?? '';
        if (!org) warnings.push({ field, reason: 'Org not found' });
        break;

      case 'sales_rep_name':
        if (closerUser) {
          values[field] = closerUser.name;
        } else {
          warnings.push({ field, reason: 'No closer assigned to project — cannot resolve sales_rep_name' });
          values[field] = '';
        }
        break;

      case 'sales_rep_email':
        if (closerUser) {
          values[field] = closerUser.email;
        } else {
          warnings.push({ field, reason: 'No closer assigned to project — cannot resolve sales_rep_email' });
          values[field] = '';
        }
        break;

      case 'today':
        values[field] = formatDateShort(now);
        break;

      case 'today_long_form':
        values[field] = formatDateLong(now);
        break;

      default:
        warnings.push({ field, reason: `DB resolution not implemented for "${field}"` });
        values[field] = '';
    }
  }

  return { values, warnings };
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatCurrency(value: string): string {
  const n = parseFloat(value);
  if (isNaN(n)) return value;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function formatNumber(value: string): string {
  const n = parseFloat(value);
  if (isNaN(n)) return value;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function formatDateShort(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function formatDateLong(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
