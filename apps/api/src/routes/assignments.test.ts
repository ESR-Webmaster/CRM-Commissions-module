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
import { createAssignmentsRouter } from './assignments';
import { planAssignments, auditLog } from '../db/schema/index';

const TEST_KEY = 'test-jwt-signing-key-assignments-2-2';

function signToken(payload: { org_id: string; user_id: string; role: string }) {
  return jwt.sign(payload, TEST_KEY, { algorithm: 'HS256', expiresIn: '1h' });
}

function buildApp() {
  const db = getTestDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createAuthMiddleware(db, TEST_KEY));
  app.use('/api/v1/plan-assignments', createAssignmentsRouter(db));
  return app;
}

function futureDate(daysAhead = 1) {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString();
}

function pastDate(daysAgo = 30) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

describe('Plan Assignments API (Story 2.2)', () => {
  const app = buildApp();
  const adminId = crypto.randomUUID();
  const repId = crypto.randomUUID();

  beforeAll(() => { /* app built above */ });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => { await resetDb(getTestDb()); });

  it('POST creates assignment → 201 + audit_log', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const userId = crypto.randomUUID();

    const res = await request(app)
      .post('/api/v1/plan-assignments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plan_id: plan.id,
        user_id: userId,
        role: 'closer',
        effective_from: futureDate(1),
      });

    expect(res.status).toBe(201);
    expect(res.body.planId).toBe(plan.id);
    expect(res.body.userId).toBe(userId);
    expect(res.body.role).toBe('closer');

    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('assignment_created');
  });

  it('POST with overlapping date range → 409 overlapping_assignment', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const userId = crypto.randomUUID();

    await request(app)
      .post('/api/v1/plan-assignments')
      .set('Authorization', `Bearer ${token}`)
      .send({ plan_id: plan.id, user_id: userId, role: 'closer', effective_from: futureDate(1) });

    const res = await request(app)
      .post('/api/v1/plan-assignments')
      .set('Authorization', `Bearer ${token}`)
      .send({ plan_id: plan.id, user_id: userId, role: 'closer', effective_from: futureDate(2) });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('overlapping_assignment');
  });

  it('POST plan from another org → 404', async () => {
    const db = getTestDb();
    const orgA = await createOrg(db, { name: 'Org A' });
    const orgB = await createOrg(db, { name: 'Org B' });
    const planB = await createPlan(db, orgB.id);
    const tokenA = signToken({ org_id: orgA.id, user_id: adminId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/plan-assignments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ plan_id: planB.id, user_id: crypto.randomUUID(), role: 'closer', effective_from: futureDate(1) });

    expect(res.status).toBe(404);
  });

  it('POST with effective_to before effective_from → 400', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/plan-assignments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plan_id: plan.id,
        user_id: crypto.randomUUID(),
        role: 'closer',
        effective_from: futureDate(5),
        effective_to: futureDate(1),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('effective_to_must_be_after_effective_from');
  });

  it('GET lists assignments for org only', async () => {
    const db = getTestDb();
    const orgA = await createOrg(db, { name: 'Org A' });
    const orgB = await createOrg(db, { name: 'Org B' });
    const planA = await createPlan(db, orgA.id);
    const planB = await createPlan(db, orgB.id);
    const tokenA = signToken({ org_id: orgA.id, user_id: repId, role: 'rep' });
    const userId = crypto.randomUUID();

    // Create assignment in each org
    await db.insert(planAssignments).values({
      planId: planA.id, orgId: orgA.id, userId, role: 'closer',
      defaultSplitPercent: '100.00', effectiveFrom: new Date(pastDate(10)),
    });
    await db.insert(planAssignments).values({
      planId: planB.id, orgId: orgB.id, userId, role: 'closer',
      defaultSplitPercent: '100.00', effectiveFrom: new Date(pastDate(10)),
    });

    const res = await request(app)
      .get('/api/v1/plan-assignments')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0].orgId).toBe(orgA.id);
  });

  it('GET ?user_id= filters by user', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const token = signToken({ org_id: org.id, user_id: repId, role: 'rep' });
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();

    await db.insert(planAssignments).values([
      { planId: plan.id, orgId: org.id, userId: userA, role: 'closer', defaultSplitPercent: '100.00', effectiveFrom: new Date(pastDate(10)) },
      { planId: plan.id, orgId: org.id, userId: userB, role: 'setter', defaultSplitPercent: '100.00', effectiveFrom: new Date(pastDate(10)) },
    ]);

    const res = await request(app)
      .get(`/api/v1/plan-assignments?user_id=${userA}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0].userId).toBe(userA);
  });

  it('DELETE deactivates assignment → sets effectiveTo + audit_log', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const plan = await createPlan(db, org.id);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });

    const [assignment] = await db.insert(planAssignments).values({
      planId: plan.id, orgId: org.id, userId: crypto.randomUUID(), role: 'closer',
      defaultSplitPercent: '100.00', effectiveFrom: new Date(pastDate(10)),
    }).returning();

    const res = await request(app)
      .delete(`/api/v1/plan-assignments/${assignment!.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.effectiveTo).toBeDefined();

    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('assignment_deactivated');
  });

  it('DELETE assignment from another org → 404', async () => {
    const db = getTestDb();
    const orgA = await createOrg(db, { name: 'Org A' });
    const orgB = await createOrg(db, { name: 'Org B' });
    const planB = await createPlan(db, orgB.id);
    const tokenA = signToken({ org_id: orgA.id, user_id: adminId, role: 'admin' });

    const [assignment] = await db.insert(planAssignments).values({
      planId: planB.id, orgId: orgB.id, userId: crypto.randomUUID(), role: 'closer',
      defaultSplitPercent: '100.00', effectiveFrom: new Date(pastDate(10)),
    }).returning();

    const res = await request(app)
      .delete(`/api/v1/plan-assignments/${assignment!.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});
