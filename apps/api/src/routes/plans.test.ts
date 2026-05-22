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
} from '../test/fixtures/engine-fixtures';
import { createAuthMiddleware } from '../middleware/auth';
import { createPlansRouter } from './plans';
import { auditLog, commissionEvents, commissionPlans } from '../db/schema/index';

const TEST_SIGNING_KEY = 'test-jwt-signing-key-for-plans-story-2-1';
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

function signToken(payload: { org_id: string; user_id: string; role: string }) {
  return jwt.sign(payload, TEST_SIGNING_KEY, { algorithm: 'HS256', expiresIn: '1h' });
}

function buildTestApp() {
  const db = getTestDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createAuthMiddleware(db, TEST_SIGNING_KEY));
  app.use('/api/v1/plans', createPlansRouter(db));
  return app;
}

function futureDate(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function validPercentPlan(overrides?: Record<string, unknown>) {
  return {
    name: 'Standard Closer',
    calculation_type: 'percent_contract',
    rules: { percent: 3 },
    earned_trigger_stage: 'install_complete',
    payable_trigger: { type: 'stage', value: 'install_complete' },
    effective_from: futureDate(),
    ...overrides,
  };
}

describe('Plans API (Story 2.1)', () => {
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
    await resetDb(getTestDb());
  });

  // ── POST /api/v1/plans ──────────────────────────────────────────────────────

  it('POST creates plan, returns full object, writes audit_log', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/plans')
      .set('Authorization', `Bearer ${token}`)
      .send(validPercentPlan());

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.orgId).toBe(org.id);
    expect(res.body.name).toBe('Standard Closer');
    expect(res.body.calculationType).toBe('percent_contract');
    expect(res.body.createdAt).toBeDefined();

    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('plan_created');
    expect(logs[0]!.entityId).toBe(res.body.id);
  });

  it('POST with percent_contract missing rules.percent → 400', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/plans')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPercentPlan(), rules: {} });

    expect(res.status).toBe(400);
    expect(res.body.details).toBeDefined();
  });

  it('POST with effective_from in the past → 400 effective_from_must_be_future', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/plans')
      .set('Authorization', `Bearer ${token}`)
      .send(validPercentPlan({ effective_from: '2020-01-01T00:00:00.000Z' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('effective_from_must_be_future');
  });

  it('POST duplicate (same org + name + is_active) → 409', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    await request(app)
      .post('/api/v1/plans')
      .set('Authorization', `Bearer ${token}`)
      .send(validPercentPlan());

    const res = await request(app)
      .post('/api/v1/plans')
      .set('Authorization', `Bearer ${token}`)
      .send(validPercentPlan());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('plan_name_conflict');
  });

  it('POST with rules.percent out of range (0) → 400', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/plans')
      .set('Authorization', `Bearer ${token}`)
      .send(validPercentPlan({ rules: { percent: 0 } }));

    expect(res.status).toBe(400);
  });

  it('POST ppw plan with dollars_per_watt out of range (>50) → 400', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/plans')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...validPercentPlan(),
        calculation_type: 'ppw',
        rules: { dollars_per_watt: 51 },
      });

    expect(res.status).toBe(400);
  });

  // ── GET /api/v1/plans ───────────────────────────────────────────────────────

  it('GET lists plans ordered by effective_from desc', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: repUserId, role: 'rep' });

    await createPlan(db, org.id, {
      name: 'Plan A',
      effectiveFrom: new Date('2025-01-01'),
    });
    await createPlan(db, org.id, {
      name: 'Plan B',
      effectiveFrom: new Date('2026-01-01'),
    });

    const res = await request(app)
      .get('/api/v1/plans')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(2);
    expect(res.body.plans[0]!.name).toBe('Plan B'); // more recent first
    expect(res.body.total).toBe(2);
  });

  it('GET ?is_active=true filters correctly', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: repUserId, role: 'rep' });

    await createPlan(db, org.id, { name: 'Active Plan', isActive: true });
    await createPlan(db, org.id, { name: 'Inactive Plan', isActive: false });

    const res = await request(app)
      .get('/api/v1/plans?is_active=true')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0]!.name).toBe('Active Plan');
  });

  it('GET ?calculation_type=ppw filters correctly', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: repUserId, role: 'rep' });

    await createPlan(db, org.id, { name: 'Percent Plan', calculationType: 'percent_contract' });
    await createPlan(db, org.id, {
      name: 'PPW Plan',
      calculationType: 'ppw',
      rules: { dollars_per_watt: 0.15 },
    });

    const res = await request(app)
      .get('/api/v1/plans?calculation_type=ppw')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0]!.name).toBe('PPW Plan');
  });

  it('GET returns only plans for the JWT org (org isolation)', async () => {
    const db = getTestDb();
    const orgA = await createOrg(db, { name: 'Org A' });
    const orgB = await createOrg(db, { name: 'Org B' });
    const tokenA = signToken({ org_id: orgA.id, user_id: repUserId, role: 'rep' });

    await createPlan(db, orgA.id, { name: 'Org A Plan' });
    await createPlan(db, orgB.id, { name: 'Org B Plan' });

    const res = await request(app)
      .get('/api/v1/plans')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0]!.name).toBe('Org A Plan');
  });

  // ── PUT /api/v1/plans/:id ───────────────────────────────────────────────────

  it('PUT updates plan with no events → 200, audit_log written', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id, { name: 'Old Name' });
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .put(`/api/v1/plans/${plan.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');

    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('plan_updated');
  });

  it('PUT changing calculation_type on plan with events → 422', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    // Seed a commission event linked to this plan
    await db.insert(commissionEvents).values({
      orgId: org.id,
      projectId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      planId: plan.id,
      eventType: 'earned',
      amount: '750.00',
      status: 'approved',
      createdBy: SYSTEM_ACTOR,
    });

    const res = await request(app)
      .put(`/api/v1/plans/${plan.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ calculation_type: 'ppw', rules: { dollars_per_watt: 0.15 } });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('plan_has_events_immutable_fields');

    // Plan must be unchanged
    const [unchanged] = await db
      .select({ calculationType: commissionPlans.calculationType })
      .from(commissionPlans)
      .where(eq(commissionPlans.id, plan.id));
    expect(unchanged!.calculationType).toBe('percent_contract');
  });

  it('PUT on plan belonging to another org → 404', async () => {
    const db = getTestDb();
    const orgA = await createOrg(db, { name: 'Org A' });
    const orgB = await createOrg(db, { name: 'Org B' });
    const planB = await createPlan(db, orgB.id, { name: 'Org B Plan' });
    const tokenA = signToken({ org_id: orgA.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .put(`/api/v1/plans/${planB.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
  });

  // ── POST /api/v1/plans/:id/end-and-replace ──────────────────────────────────

  it('end-and-replace: ends old plan, creates new, two audit_log rows, single transaction', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const oldPlan = await createPlan(db, org.id, { name: 'Old Plan', rules: { percent: 3 } });
    const token = signToken({ org_id: org.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/plans/${oldPlan.id}/end-and-replace`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rules: { percent: 5 } });

    expect(res.status).toBe(201);
    expect(res.body.ended).toBeDefined();
    expect(res.body.created).toBeDefined();

    // Old plan is ended and inactive
    const [endedPlan] = await db
      .select()
      .from(commissionPlans)
      .where(eq(commissionPlans.id, oldPlan.id));
    expect(endedPlan!.isActive).toBe(false);
    expect(endedPlan!.effectiveTo).toBeDefined();

    // New plan inherits name but has updated rules
    expect(res.body.created.name).toBe('Old Plan');
    expect(res.body.created.rules).toEqual({ percent: 5 });
    expect(res.body.created.isActive).toBe(true);

    // Two audit_log rows
    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(2);
    const actions = logs.map((l) => l.action).sort();
    expect(actions).toEqual(['plan_created', 'plan_ended']);
  });

  it('end-and-replace on plan in another org → 404', async () => {
    const db = getTestDb();
    const orgA = await createOrg(db, { name: 'Org A' });
    const orgB = await createOrg(db, { name: 'Org B' });
    const planB = await createPlan(db, orgB.id);
    const tokenA = signToken({ org_id: orgA.id, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .post(`/api/v1/plans/${planB.id}/end-and-replace`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});

    expect(res.status).toBe(404);
  });
});
