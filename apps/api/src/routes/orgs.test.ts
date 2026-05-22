import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import {
  getTestDb,
  closeTestDb,
  resetDb,
  createOrg,
  createPlan,
  createPlanAssignment,
  createProject,
} from '../test/fixtures/engine-fixtures';
import { createAuthMiddleware } from '../middleware/auth';
import { createOrgsRouter } from './orgs';
import { auditLog, commissionEvents, orgs } from '../db/schema/index';
import { processStageTransition } from '../services/commissionEngine';
import pino from 'pino';

const TEST_SIGNING_KEY = 'test-jwt-signing-key-for-orgs-story-1-6';
const nullLogger = pino({ level: 'silent' });

function signToken(payload: { org_id: string; user_id: string; role: string }) {
  return jwt.sign(payload, TEST_SIGNING_KEY, { algorithm: 'HS256', expiresIn: '1h' });
}

function buildTestApp() {
  const db = getTestDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createAuthMiddleware(db, TEST_SIGNING_KEY));
  app.use('/api/v1/orgs', createOrgsRouter(db));
  return app;
}

describe('Orgs settings API (Story 1.6)', () => {
  let app: ReturnType<typeof buildTestApp>;
  const adminUserId = crypto.randomUUID();
  const repUserId = crypto.randomUUID();

  beforeAll(() => {
    app = buildTestApp();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    const db = getTestDb();
    await resetDb(db);
  });

  // ── AC1: GET /api/v1/orgs/me/settings ───────────────────────────────────────

  it('AC1: GET returns require_event_approval = false for default org', async () => {
    const db = getTestDb();
    const org = await createOrg(db, { settings: { require_event_approval: false } });
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .get('/api/v1/orgs/me/settings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ require_event_approval: false });
  });

  it('AC1: GET reflects require_event_approval = true when org has it set', async () => {
    const db = getTestDb();
    const org = await createOrg(db, { settings: { require_event_approval: true } });
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .get('/api/v1/orgs/me/settings')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ require_event_approval: true });
  });

  // ── AC2: PATCH updates setting and writes audit_log ──────────────────────────

  it('AC2: admin PATCH updates setting, echoes it, and writes audit_log', async () => {
    const db = getTestDb();
    const org = await createOrg(db, { settings: { require_event_approval: true } });
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .patch('/api/v1/orgs/me/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ require_event_approval: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ require_event_approval: false });

    // Verify DB was updated
    const [updated] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, org.id));
    expect(updated!.settings.require_event_approval).toBe(false);

    // Verify audit_log row
    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.entityType).toBe('org');
    expect(logs[0]!.action).toBe('settings_updated');
    expect(logs[0]!.actorUserId).toBe(adminUserId);
    expect(logs[0]!.entityId).toBe(org.id);
    expect(logs[0]!.before).toEqual({ require_event_approval: true });
    expect(logs[0]!.after).toEqual({ require_event_approval: false });
  });

  // ── AC3: rep JWT → 403 on PATCH, no side effects ────────────────────────────

  it('AC3: rep JWT → 403 on PATCH, audit_log not written, setting unchanged', async () => {
    const db = getTestDb();
    const org = await createOrg(db, { settings: { require_event_approval: true } });
    const repToken = signToken({ org_id: org.id, user_id: repUserId, role: 'rep' });

    const res = await request(app)
      .patch('/api/v1/orgs/me/settings')
      .set('Authorization', `Bearer ${repToken}`)
      .send({ require_event_approval: false });

    expect(res.status).toBe(403);

    // Setting unchanged
    const [unchanged] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, org.id));
    expect(unchanged!.settings.require_event_approval).toBe(true);

    // No audit_log row
    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(0);
  });

  // ── AC5: invalid PATCH body → 400 ────────────────────────────────────────────

  it('AC5: PATCH with invalid body ({ require_event_approval: "yes" }) → 400', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .patch('/api/v1/orgs/me/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ require_event_approval: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.details).toBeDefined();
  });

  // ── AC4: non-retroactive toggle ───────────────────────────────────────────────

  it('AC4: existing pending events stay pending after toggle; new events get approved status', async () => {
    const db = getTestDb();

    // Org with approval required
    const org = await createOrg(db, { settings: { require_event_approval: true } });
    const adminToken = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    // Create setup for two stage transitions
    const plan = await createPlan(db, org.id, { calculationType: 'percent_contract', rules: { percent: 3 } });
    const repId = crypto.randomUUID();
    await createPlanAssignment(db, { orgId: org.id, planId: plan.id, userId: repId, role: 'closer' });

    // Project 1: fire transition now (setting = true → pending)
    const project1 = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });
    const result1 = await processStageTransition(
      {
        org_id: org.id,
        project_id: project1.projectId,
        to_stage: 'install_complete',
        transition_id: crypto.randomUUID(),
        delivery_id: null,
        occurred_at: new Date(),
      },
      db,
      nullLogger
    );
    expect(result1.events_created[0]!.status).toBe('pending');

    // Toggle setting to false
    const patchRes = await request(app)
      .patch('/api/v1/orgs/me/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ require_event_approval: false });
    expect(patchRes.status).toBe(200);

    // Existing pending event is still pending
    const [existingEvent] = await db
      .select({ status: commissionEvents.status })
      .from(commissionEvents)
      .where(eq(commissionEvents.id, result1.events_created[0]!.id));
    expect(existingEvent!.status).toBe('pending');

    // Project 2: fire new transition (setting = false → approved)
    const project2 = await createProject(db, {
      orgId: org.id,
      repAssignments: [{ user_id: repId, role: 'closer', split_percent: 100 }],
    });
    const result2 = await processStageTransition(
      {
        org_id: org.id,
        project_id: project2.projectId,
        to_stage: 'install_complete',
        transition_id: crypto.randomUUID(),
        delivery_id: null,
        occurred_at: new Date(),
      },
      db,
      nullLogger
    );
    expect(result2.events_created[0]!.status).toBe('approved');
  });
});
