import { eq, and, count } from 'drizzle-orm';
import type { Db } from '../../db/index';
import { docusealTemplates } from '../../db/schema/docuseal';
import type { DocusealClient } from './client';
import pino from 'pino';

const logger = pino({ name: 'docuseal-seed' });

// ── Starter template definitions ──────────────────────────────────────────────
// These define what gets seeded. `masterDocusealId` is the template ID in the
// Sunscape master DocuSeal account. Set DOCUSEAL_STARTER_TEMPLATE_IDS in env
// as a comma-separated list matching this order; if absent, seeding is skipped.

export const STARTER_TEMPLATES = [
  { key: 'install_agreement',  name: 'Install Agreement',     category: 'install_agreement'  as const },
  { key: 'change_order',       name: 'Change Order',          category: 'change_order'       as const },
  { key: 'site_survey_consent', name: 'Site Survey Consent',  category: 'consent'            as const },
  { key: 'nem_authorization',  name: 'NEM Authorization',     category: 'disclosure'         as const },
  { key: 'hoa_disclosure',     name: 'HOA Disclosure',        category: 'disclosure'         as const },
  { key: 'final_acceptance',   name: 'Final Acceptance',      category: 'consent'            as const },
] as const;

// ── Main seeder ───────────────────────────────────────────────────────────────

export async function seedStarterTemplates(opts: {
  db: Db;
  client: DocusealClient;
  orgId: string;
}): Promise<{ seeded: number; skipped: string }> {
  const { db, client, orgId } = opts;

  // Read master template IDs from env
  const masterIds = parseMasterTemplateIds();
  if (masterIds.length === 0) {
    return { seeded: 0, skipped: 'DOCUSEAL_STARTER_TEMPLATE_IDS not configured' };
  }

  // Only seed if org has zero templates
  const countRows = await db
    .select({ value: count() })
    .from(docusealTemplates)
    .where(and(eq(docusealTemplates.orgId, orgId), eq(docusealTemplates.isArchived, false)));

  const existingCount = countRows[0]?.value ?? 0;
  if (existingCount > 0) {
    return { seeded: 0, skipped: `Org already has ${existingCount} template(s)` };
  }

  let seeded = 0;
  for (let i = 0; i < STARTER_TEMPLATES.length; i++) {
    const def = STARTER_TEMPLATES[i]!;
    const masterDocusealId = masterIds[i];
    if (!masterDocusealId) continue;

    try {
      // Duplicate from the Sunscape master account into this org's account
      const remote = await client.getTemplate(masterDocusealId);

      const mergeFields = (remote.fields ?? []).map((f) => f.name);
      const signerRoles = (remote.submitters ?? []).map((s, idx) => ({ name: s.name, order: idx + 1 }));

      await db
        .insert(docusealTemplates)
        .values({
          orgId,
          docusealId: masterDocusealId,
          name: def.name,
          category: def.category,
          mergeFields,
          signerRoles,
        })
        .onConflictDoNothing();

      seeded++;
      logger.info({ orgId, template: def.name, docusealId: masterDocusealId }, 'Starter template seeded');
    } catch (err) {
      logger.warn({ orgId, template: def.name, masterDocusealId, err }, 'Failed to seed starter template — skipping');
    }
  }

  return { seeded, skipped: seeded === STARTER_TEMPLATES.length ? '' : 'Some templates failed — check logs' };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseMasterTemplateIds(): string[] {
  const raw = process.env['DOCUSEAL_STARTER_TEMPLATE_IDS'] ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
