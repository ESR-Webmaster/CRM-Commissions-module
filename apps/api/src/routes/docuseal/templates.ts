import { Router } from 'express';
import { z } from 'zod';
import { eq, and, ilike, desc } from 'drizzle-orm';
import type { Db } from '../../db/index';
import { docusealConfig, docusealTemplates } from '../../db/schema/docuseal';
import type { DocusealTemplateCategory } from '../../db/schema/docuseal';
import { requireAdmin } from '../../middleware/auth';
import { createDocusealClient } from '../../services/docuseal/client';
import pino from 'pino';

const logger = pino({ name: 'docuseal-templates' });

const TEMPLATE_CATEGORIES: DocusealTemplateCategory[] = [
  'proposal',
  'install_agreement',
  'change_order',
  'consent',
  'disclosure',
  'other',
];

const createTemplateSchema = z.object({
  docuseal_id: z.string().min(1),
  name: z.string().min(1).max(255),
  category: z.enum(['proposal', 'install_agreement', 'change_order', 'consent', 'disclosure', 'other']),
});

const patchTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  category: z.enum(['proposal', 'install_agreement', 'change_order', 'consent', 'disclosure', 'other']).optional(),
  is_archived: z.boolean().optional(),
});

async function getActiveClient(db: Db, orgId: string) {
  const [config] = await db
    .select()
    .from(docusealConfig)
    .where(and(eq(docusealConfig.orgId, orgId), eq(docusealConfig.isActive, true)))
    .limit(1);
  if (!config) return null;
  return createDocusealClient({
    apiToken: config.apiToken,
    orgId,
    mode: config.mode as 'saas' | 'self_hosted',
    endpointUrl: config.endpointUrl,
  });
}

export function createDocusealTemplatesRouter(db: Db): Router {
  const router = Router();

  // ── GET /api/v1/docuseal/templates ────────────────────────────────────────
  // List templates. Admins see all; non-admins see active (non-archived) only.

  router.get('/', async (req, res): Promise<void> => {
    const querySchema = z.object({
      category: z.enum(['proposal', 'install_agreement', 'change_order', 'consent', 'disclosure', 'other']).optional(),
      archived: z.enum(['true', 'false']).optional(),
      search: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
      return;
    }

    const { category, archived, search, limit, offset } = parsed.data;
    const isAdmin = req.auth.role === 'admin';

    // Non-admins only see active templates
    const showArchived = isAdmin && archived === 'true';

    let query = db
      .select()
      .from(docusealTemplates)
      .where(
        and(
          eq(docusealTemplates.orgId, req.auth.org_id),
          showArchived ? undefined : eq(docusealTemplates.isArchived, false),
          category ? eq(docusealTemplates.category, category) : undefined,
          search ? ilike(docusealTemplates.name, `%${search}%`) : undefined,
        )
      )
      .$dynamic();

    const rows = await query
      .orderBy(desc(docusealTemplates.updatedAt))
      .limit(limit)
      .offset(offset);

    res.json({ templates: rows, limit, offset, total: rows.length });
  });

  // ── POST /api/v1/docuseal/templates ───────────────────────────────────────
  // Register a template (admin only). Syncs metadata from DocuSeal by ID.

  router.post('/', requireAdmin, async (req, res): Promise<void> => {
    const parsed = createTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const { docuseal_id, name, category } = parsed.data;

    const client = await getActiveClient(db, req.auth.org_id);
    if (!client) {
      res.status(422).json({ error: 'docuseal_not_configured' });
      return;
    }

    let remote;
    try {
      remote = await client.getTemplate(docuseal_id);
    } catch {
      res.status(422).json({ error: 'docuseal_template_not_found', docuseal_id });
      return;
    }

    const mergeFields: string[] = (remote.fields ?? []).map((f) => f.name);
    const signerRoles = (remote.submitters ?? []).map((s, i) => ({ name: s.name, order: i + 1 }));

    const rows = await db
      .insert(docusealTemplates)
      .values({
        orgId: req.auth.org_id,
        docusealId: docuseal_id,
        name,
        category,
        mergeFields,
        signerRoles,
      })
      .returning();

    const created = rows[0];
    if (!created) { res.status(500).json({ error: 'insert_failed' }); return; }

    logger.info({ orgId: req.auth.org_id, templateId: created.id, docusealId: docuseal_id }, 'Template registered');
    res.status(201).json(created);
  });

  // ── GET /api/v1/docuseal/templates/:id ────────────────────────────────────

  router.get('/:id', async (req, res): Promise<void> => {
    const [row] = await db
      .select()
      .from(docusealTemplates)
      .where(and(eq(docusealTemplates.id, req.params['id']!), eq(docusealTemplates.orgId, req.auth.org_id)))
      .limit(1);

    if (!row) { res.status(404).json({ error: 'template_not_found' }); return; }
    res.json(row);
  });

  // ── PATCH /api/v1/docuseal/templates/:id ─────────────────────────────────

  router.patch('/:id', requireAdmin, async (req, res): Promise<void> => {
    const parsed = patchTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const [existing] = await db
      .select()
      .from(docusealTemplates)
      .where(and(eq(docusealTemplates.id, req.params['id']!), eq(docusealTemplates.orgId, req.auth.org_id)))
      .limit(1);

    if (!existing) { res.status(404).json({ error: 'template_not_found' }); return; }

    const updates: Partial<typeof existing> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.category !== undefined) updates.category = parsed.data.category;
    if (parsed.data.is_archived !== undefined) updates.isArchived = parsed.data.is_archived;

    const [updated] = await db
      .update(docusealTemplates)
      .set(updates)
      .where(eq(docusealTemplates.id, existing.id))
      .returning();

    res.json(updated);
  });

  // ── POST /api/v1/docuseal/templates/:id/duplicate ─────────────────────────

  router.post('/:id/duplicate', requireAdmin, async (req, res): Promise<void> => {
    const [source] = await db
      .select()
      .from(docusealTemplates)
      .where(and(eq(docusealTemplates.id, req.params['id']!), eq(docusealTemplates.orgId, req.auth.org_id)))
      .limit(1);

    if (!source) { res.status(404).json({ error: 'template_not_found' }); return; }

    const client = await getActiveClient(db, req.auth.org_id);
    if (!client) { res.status(422).json({ error: 'docuseal_not_configured' }); return; }

    // Duplicate in DocuSeal first (if their API supports it), then mirror
    let newDocusealId = source.docusealId;
    try {
      const duped = await (client as unknown as { duplicateTemplate?: (id: string) => Promise<{ id: string }> })
        .duplicateTemplate?.(source.docusealId);
      if (duped) newDocusealId = duped.id;
    } catch {
      // DocuSeal duplicate API not available — reuse same remote template, new local record
    }

    const rows = await db
      .insert(docusealTemplates)
      .values({
        orgId: req.auth.org_id,
        docusealId: newDocusealId,
        name: `${source.name} (Copy)`,
        category: source.category,
        version: 1,
        parentId: source.id,
        mergeFields: source.mergeFields,
        signerRoles: source.signerRoles,
        isArchived: false,
      })
      .returning();

    const copy = rows[0];
    if (!copy) { res.status(500).json({ error: 'insert_failed' }); return; }
    res.status(201).json(copy);
  });

  // ── GET /api/v1/docuseal/templates/:id/versions ───────────────────────────

  router.get('/:id/versions', requireAdmin, async (req, res): Promise<void> => {
    const [root] = await db
      .select()
      .from(docusealTemplates)
      .where(and(eq(docusealTemplates.id, req.params['id']!), eq(docusealTemplates.orgId, req.auth.org_id)))
      .limit(1);

    if (!root) { res.status(404).json({ error: 'template_not_found' }); return; }

    // Walk the parent chain to collect the version history (most recent first, max 5)
    const versions = [root];
    let current = root;
    while (current.parentId && versions.length < 5) {
      const [parent] = await db
        .select()
        .from(docusealTemplates)
        .where(and(eq(docusealTemplates.id, current.parentId), eq(docusealTemplates.orgId, req.auth.org_id)))
        .limit(1);
      if (!parent) break;
      versions.push(parent);
      current = parent;
    }

    res.json({ versions });
  });

  // ── POST /api/v1/docuseal/templates/:id/restore-version ───────────────────

  router.post('/:id/restore-version', requireAdmin, async (req, res): Promise<void> => {
    const bodySchema = z.object({ version_id: z.string().uuid() });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const [current] = await db
      .select()
      .from(docusealTemplates)
      .where(and(eq(docusealTemplates.id, req.params['id']!), eq(docusealTemplates.orgId, req.auth.org_id)))
      .limit(1);

    if (!current) { res.status(404).json({ error: 'template_not_found' }); return; }

    const [sourceVersion] = await db
      .select()
      .from(docusealTemplates)
      .where(and(eq(docusealTemplates.id, parsed.data.version_id), eq(docusealTemplates.orgId, req.auth.org_id)))
      .limit(1);

    if (!sourceVersion) { res.status(404).json({ error: 'version_not_found' }); return; }

    // Restore = create a new version row pointing at the current as parent
    const rows = await db
      .insert(docusealTemplates)
      .values({
        orgId: req.auth.org_id,
        docusealId: sourceVersion.docusealId,
        name: current.name,
        category: current.category,
        version: current.version + 1,
        parentId: current.id,
        mergeFields: sourceVersion.mergeFields,
        signerRoles: sourceVersion.signerRoles,
        isArchived: false,
      })
      .returning();

    const restored = rows[0];
    if (!restored) { res.status(500).json({ error: 'insert_failed' }); return; }
    res.status(201).json(restored);
  });

  // ── GET /api/v1/docuseal/templates/categories ─────────────────────────────

  router.get('/meta/categories', (_req, res): void => {
    res.json({ categories: TEMPLATE_CATEGORIES });
  });

  return router;
}
