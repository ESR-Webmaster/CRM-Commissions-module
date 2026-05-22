import { describe, it, expect, afterAll, beforeEach } from 'vitest';
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
  createUser,
  createProject,
} from '../test/fixtures/engine-fixtures';
import { createAuthMiddleware } from '../middleware/auth';
import { createStatementsRouter } from './statements';
import { commissionEvents } from '../db/schema/events';
import { auditLog } from '../db/schema/index';

const TEST_KEY = 'test-jwt-signing-key-statements-5-1';

function signToken(payload: { org_id: string; user_id: string; role: string }) {
  return jwt.sign(payload, TEST_KEY, { algorithm: 'HS256', expiresIn: '1h' });
}

function buildApp() {
  const db = getTestDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createAuthMiddleware(db, TEST_KEY));
  app.use('/api/v1/statements', createStatementsRouter(db));
  return app;
}

async function seedApprovedEvent(
  db: ReturnType<typeof getTestDb>,
  orgId: string,
  userId: string,
  planId: string,
  projectId: string,
  status: 'approved' | 'paid' = 'approved'
) {
  const [row] = await db
    .insert(commissionEvents)
    .values({
      orgId,
      projectId,
      userId,
      planId,
      eventType: 'earned',
      amount: '1000.00',
      triggeringStageTransitionId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      status,
      createdBy: userId,
    })
    .returning();
  return row!;
}

describe('Statements API (Story 5.1)', () => {
  const app = buildApp();
  const adminId = crypto.randomUUID();

  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => { await resetDb(getTestDb()); });

  it('POST /generate creates statement for approved events → 201 + audit_log', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });
    await seedApprovedEvent(db, org.id, user.id, plan.id, proj.projectId);

    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();

    const res = await request(app)
      .post('/api/v1/statements/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ rep_user_id: user.id, period_start: start, period_end: end });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(user.id);
    expect(Number(res.body.totalEarned)).toBe(1000);
    expect(Number(res.body.netPayable)).toBe(1000);
    expect(res.body.status).toBe('draft');
    expect(res.body.eventIds).toHaveLength(1);

    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('statement_generated');
  });

  it('POST /generate with no eligible events → 422 no_eligible_events', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();

    const res = await request(app)
      .post('/api/v1/statements/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ rep_user_id: user.id, period_start: start, period_end: end });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_eligible_events');
  });

  it('POST /generate as rep → 403 forbidden', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const token = signToken({ org_id: org.id, user_id: user.id, role: 'rep' });

    const res = await request(app)
      .post('/api/v1/statements/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ rep_user_id: user.id, period_start: new Date().toISOString(), period_end: new Date().toISOString() });

    expect(res.status).toBe(403);
  });

  it('POST /:id/approve transitions draft → approved', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });
    await seedApprovedEvent(db, org.id, user.id, plan.id, proj.projectId);

    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();

    const genRes = await request(app)
      .post('/api/v1/statements/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ rep_user_id: user.id, period_start: start, period_end: end });
    expect(genRes.status).toBe(201);

    const approveRes = await request(app)
      .post(`/api/v1/statements/${genRes.body.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('approved');
  });

  it('POST /:id/mark-paid transitions approved → paid and marks events paid', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });
    const ev = await seedApprovedEvent(db, org.id, user.id, plan.id, proj.projectId);

    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();

    const genRes = await request(app)
      .post('/api/v1/statements/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ rep_user_id: user.id, period_start: start, period_end: end });

    await request(app)
      .post(`/api/v1/statements/${genRes.body.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    const paidRes = await request(app)
      .post(`/api/v1/statements/${genRes.body.id}/mark-paid`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(paidRes.status).toBe(200);
    expect(paidRes.body.status).toBe('paid');

    const [updatedEvent] = await db
      .select()
      .from(commissionEvents)
      .where(eq(commissionEvents.id, ev.id));
    expect(updatedEvent!.status).toBe('paid');
  });

  it('GET / org isolation — rep only sees own statements', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const rep1 = await createUser(db, org.id);
    const rep2 = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj1 = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: rep1.id, role: 'closer', split_percent: 100 }] });
    const proj2 = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: rep2.id, role: 'closer', split_percent: 100 }] });
    await seedApprovedEvent(db, org.id, rep1.id, plan.id, proj1.projectId);
    await seedApprovedEvent(db, org.id, rep2.id, plan.id, proj2.projectId);

    const adminToken = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();

    await request(app)
      .post('/api/v1/statements/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rep_user_id: rep1.id, period_start: start, period_end: end });

    await request(app)
      .post('/api/v1/statements/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rep_user_id: rep2.id, period_start: start, period_end: end });

    const rep1Token = signToken({ org_id: org.id, user_id: rep1.id, role: 'rep' });
    const res = await request(app)
      .get('/api/v1/statements')
      .set('Authorization', `Bearer ${rep1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.statements).toHaveLength(1);
    expect(res.body.statements[0].userId).toBe(rep1.id);
  });

  it('GET /:id/csv returns CSV with correct headers', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });
    await seedApprovedEvent(db, org.id, user.id, plan.id, proj.projectId);

    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();

    const genRes = await request(app)
      .post('/api/v1/statements/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ rep_user_id: user.id, period_start: start, period_end: end });

    const csvRes = await request(app)
      .get(`/api/v1/statements/${genRes.body.id}/csv`)
      .set('Authorization', `Bearer ${token}`);

    expect(csvRes.status).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.text).toContain('rep_user_id,project_id,event_type');
    expect(csvRes.text).toContain('earned');
  });
});
