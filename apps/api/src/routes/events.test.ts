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
import { createEventsRouter } from './events';
import { commissionEvents, auditLog } from '../db/schema/index';

const TEST_KEY = 'test-jwt-signing-key-events-4-1';

function signToken(payload: { org_id: string; user_id: string; role: string }) {
  return jwt.sign(payload, TEST_KEY, { algorithm: 'HS256', expiresIn: '1h' });
}

function buildApp() {
  const db = getTestDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createAuthMiddleware(db, TEST_KEY));
  app.use('/api/v1/events', createEventsRouter(db));
  return app;
}

async function seedEvent(
  db: ReturnType<typeof getTestDb>,
  overrides: {
    orgId: string;
    userId: string;
    planId: string;
    projectId: string;
    status?: 'pending' | 'approved' | 'paid' | 'disputed';
    eventType?: 'earned' | 'adjusted' | 'clawed_back' | 'override_earned' | 'adder' | 'deduction';
    transitionId?: string;
  }
) {
  const [row] = await db
    .insert(commissionEvents)
    .values({
      orgId: overrides.orgId,
      projectId: overrides.projectId,
      userId: overrides.userId,
      planId: overrides.planId,
      eventType: overrides.eventType ?? 'earned',
      amount: '1000.00',
      triggeringStageTransitionId: overrides.transitionId ?? crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      status: overrides.status ?? 'pending',
      createdBy: overrides.userId,
    })
    .returning();
  return row!;
}

describe('Events API (Story 4.1)', () => {
  const app = buildApp();
  const adminId = crypto.randomUUID();

  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => { await resetDb(getTestDb()); });

  // ── GET /api/v1/events ─────────────────────────────────────────────────────

  it('GET /events returns only org events', async () => {
    const db = getTestDb();
    const org1 = await createOrg(db);
    const org2 = await createOrg(db);
    const user1 = await createUser(db, org1.id);
    const user2 = await createUser(db, org2.id);
    const plan1 = await createPlan(db, org1.id);
    const plan2 = await createPlan(db, org2.id);
    const proj1 = await createProject(db, { orgId: org1.id, repAssignments: [{ user_id: user1.id, role: 'closer', split_percent: 100 }] });
    const proj2 = await createProject(db, { orgId: org2.id, repAssignments: [{ user_id: user2.id, role: 'closer', split_percent: 100 }] });

    await seedEvent(db, { orgId: org1.id, userId: user1.id, planId: plan1.id, projectId: proj1.projectId });
    await seedEvent(db, { orgId: org2.id, userId: user2.id, planId: plan2.id, projectId: proj2.projectId });

    const token1 = signToken({ org_id: org1.id, user_id: adminId, role: 'admin' });
    const res = await request(app)
      .get('/api/v1/events')
      .set('Authorization', `Bearer ${token1}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].orgId).toBe(org1.id);
    expect(res.body.total).toBe(1);
  });

  it('GET /events filters by status', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });

    await seedEvent(db, { orgId: org.id, userId: user.id, planId: plan.id, projectId: proj.projectId, status: 'pending' });
    await seedEvent(db, { orgId: org.id, userId: user.id, planId: plan.id, projectId: proj.projectId, status: 'approved' });

    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const res = await request(app)
      .get('/api/v1/events?status=pending')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].status).toBe('pending');
  });

  it('GET /events with invalid query → 400', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });

    const res = await request(app)
      .get('/api/v1/events?status=invalid_status')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  // ── PATCH /api/v1/events/:id/status ───────────────────────────────────────

  it('PATCH /:id/status (admin) updates status + audit_log', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });
    const event = await seedEvent(db, { orgId: org.id, userId: user.id, planId: plan.id, projectId: proj.projectId });

    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const res = await request(app)
      .patch(`/api/v1/events/${event.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');

    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('event_approved');
  });

  it('PATCH /:id/status (rep) → 403 forbidden', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });
    const event = await seedEvent(db, { orgId: org.id, userId: user.id, planId: plan.id, projectId: proj.projectId });

    const token = signToken({ org_id: org.id, user_id: user.id, role: 'rep' });
    const res = await request(app)
      .patch(`/api/v1/events/${event.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'approved' });

    expect(res.status).toBe(403);
  });

  it('PATCH /:id/status on wrong org event → 404', async () => {
    const db = getTestDb();
    const org1 = await createOrg(db);
    const org2 = await createOrg(db);
    const user = await createUser(db, org2.id);
    const plan = await createPlan(db, org2.id);
    const proj = await createProject(db, { orgId: org2.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });
    const event = await seedEvent(db, { orgId: org2.id, userId: user.id, planId: plan.id, projectId: proj.projectId });

    const token = signToken({ org_id: org1.id, user_id: adminId, role: 'admin' });
    const res = await request(app)
      .patch(`/api/v1/events/${event.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'approved' });

    expect(res.status).toBe(404);
  });

  // ── POST /api/v1/events/bulk-status ───────────────────────────────────────

  it('POST /bulk-status updates multiple events + audit_log per event', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });

    const e1 = await seedEvent(db, { orgId: org.id, userId: user.id, planId: plan.id, projectId: proj.projectId });
    const e2 = await seedEvent(db, { orgId: org.id, userId: user.id, planId: plan.id, projectId: proj.projectId });

    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const res = await request(app)
      .post('/api/v1/events/bulk-status')
      .set('Authorization', `Bearer ${token}`)
      .send({ event_ids: [e1.id, e2.id], status: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(res.body.status).toBe('approved');

    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(2);
  });

  it('POST /bulk-status with events from another org → 422', async () => {
    const db = getTestDb();
    const org1 = await createOrg(db);
    const org2 = await createOrg(db);
    const user = await createUser(db, org2.id);
    const plan = await createPlan(db, org2.id);
    const proj = await createProject(db, { orgId: org2.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });
    const event = await seedEvent(db, { orgId: org2.id, userId: user.id, planId: plan.id, projectId: proj.projectId });

    const token = signToken({ org_id: org1.id, user_id: adminId, role: 'admin' });
    const res = await request(app)
      .post('/api/v1/events/bulk-status')
      .set('Authorization', `Bearer ${token}`)
      .send({ event_ids: [event.id], status: 'approved' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('some_events_not_found_or_wrong_org');
  });

  // ── POST /api/v1/events/:id/dispute ───────────────────────────────────────

  it('POST /:id/dispute sets status to disputed + audit_log', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });
    const event = await seedEvent(db, { orgId: org.id, userId: user.id, planId: plan.id, projectId: proj.projectId });

    const token = signToken({ org_id: org.id, user_id: user.id, role: 'rep' });
    const res = await request(app)
      .post(`/api/v1/events/${event.id}/dispute`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Amount looks wrong' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disputed');

    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('event_disputed');
  });

  it("POST /:id/dispute cannot dispute another user's event → 404", async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user1 = await createUser(db, org.id);
    const user2 = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user1.id, role: 'closer', split_percent: 100 }] });
    const event = await seedEvent(db, { orgId: org.id, userId: user1.id, planId: plan.id, projectId: proj.projectId });

    const token = signToken({ org_id: org.id, user_id: user2.id, role: 'rep' });
    const res = await request(app)
      .post(`/api/v1/events/${event.id}/dispute`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Not mine' });

    expect(res.status).toBe(404);
  });

  // ── GET /api/v1/me/dashboard ───────────────────────────────────────────────

  it('GET /me/dashboard returns MTD/QTD/YTD totals for approved events', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }] });

    await seedEvent(db, { orgId: org.id, userId: user.id, planId: plan.id, projectId: proj.projectId, status: 'approved' });
    await seedEvent(db, { orgId: org.id, userId: user.id, planId: plan.id, projectId: proj.projectId, status: 'pending' });

    const token = signToken({ org_id: org.id, user_id: user.id, role: 'rep' });
    const res = await request(app)
      .get('/api/v1/events/me/dashboard')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mtd');
    expect(res.body).toHaveProperty('qtd');
    expect(res.body).toHaveProperty('ytd');
    expect(res.body).toHaveProperty('by_status');
    expect(Number(res.body.mtd.total)).toBeGreaterThan(0);
    expect(res.body.mtd.count).toBeGreaterThanOrEqual(1);
  });

  // ── GET /api/v1/me/events ──────────────────────────────────────────────────

  it('GET /me/events returns only the requesting user events', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user1 = await createUser(db, org.id);
    const user2 = await createUser(db, org.id);
    const plan = await createPlan(db, org.id);
    const proj = await createProject(db, { orgId: org.id, repAssignments: [{ user_id: user1.id, role: 'closer', split_percent: 100 }] });

    await seedEvent(db, { orgId: org.id, userId: user1.id, planId: plan.id, projectId: proj.projectId });
    await seedEvent(db, { orgId: org.id, userId: user2.id, planId: plan.id, projectId: proj.projectId });

    const token = signToken({ org_id: org.id, user_id: user1.id, role: 'rep' });
    const res = await request(app)
      .get('/api/v1/events/me/events')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].userId).toBe(user1.id);
  });
});
