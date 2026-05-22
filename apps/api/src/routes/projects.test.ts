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
} from '../test/fixtures/engine-fixtures';
import { createAuthMiddleware } from '../middleware/auth';
import { createProjectsRouter } from './projects';
import { auditLog } from '../db/schema/index';

const TEST_KEY = 'test-jwt-signing-key-projects-3-1';

function signToken(payload: { org_id: string; user_id: string; role: string }) {
  return jwt.sign(payload, TEST_KEY, { algorithm: 'HS256', expiresIn: '1h' });
}

function buildApp() {
  const db = getTestDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createAuthMiddleware(db, TEST_KEY));
  app.use('/api/v1/projects', createProjectsRouter(db));
  return app;
}

describe('Projects API (Story 3.1)', () => {
  const app = buildApp();
  const adminId = crypto.randomUUID();

  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => { await resetDb(getTestDb()); });

  it('POST creates project config → 201 + audit_log', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({
        project_id: crypto.randomUUID(),
        rep_assignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }],
        contract_value: 25000,
        system_size_kw: 10,
      });

    expect(res.status).toBe(201);
    expect(res.body.orgId).toBe(org.id);
    expect(Number(res.body.contractValue)).toBe(25000);

    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('project_config_created');
  });

  it('POST upserts existing project → 200 + audit_log updated', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const projectId = crypto.randomUUID();

    await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({
        project_id: projectId,
        rep_assignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }],
        contract_value: 25000,
        system_size_kw: 10,
      });

    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({
        project_id: projectId,
        rep_assignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }],
        contract_value: 30000,
        system_size_kw: 12,
      });

    expect(res.status).toBe(200);
    expect(Number(res.body.contractValue)).toBe(30000);

    const logs = await db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(logs).toHaveLength(2);
    expect(logs[1]!.action).toBe('project_config_updated');
  });

  it('POST with unknown user_id → 422 users_not_found', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({
        project_id: crypto.randomUUID(),
        rep_assignments: [{ user_id: crypto.randomUUID(), role: 'closer', split_percent: 100 }],
        contract_value: 25000,
        system_size_kw: 10,
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('users_not_found');
  });

  it('POST with plan_override from other org → 422 plan_override_not_found', async () => {
    const db = getTestDb();
    const org1 = await createOrg(db);
    const org2 = await createOrg(db);
    const user = await createUser(db, org1.id);
    const plan = await createPlan(db, org2.id);
    const token = signToken({ org_id: org1.id, user_id: adminId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({
        project_id: crypto.randomUUID(),
        rep_assignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }],
        plan_override_id: plan.id,
        contract_value: 25000,
        system_size_kw: 10,
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('plan_override_not_found');
  });

  it('GET / returns only org projects', async () => {
    const db = getTestDb();
    const org1 = await createOrg(db);
    const org2 = await createOrg(db);
    const user1 = await createUser(db, org1.id);
    const user2 = await createUser(db, org2.id);
    const token1 = signToken({ org_id: org1.id, user_id: adminId, role: 'admin' });

    await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        project_id: crypto.randomUUID(),
        rep_assignments: [{ user_id: user1.id, role: 'closer', split_percent: 100 }],
        contract_value: 25000,
        system_size_kw: 10,
      });

    const token2 = signToken({ org_id: org2.id, user_id: adminId, role: 'admin' });
    await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token2}`)
      .send({
        project_id: crypto.randomUUID(),
        rep_assignments: [{ user_id: user2.id, role: 'closer', split_percent: 100 }],
        contract_value: 20000,
        system_size_kw: 8,
      });

    const res = await request(app)
      .get('/api/v1/projects')
      .set('Authorization', `Bearer ${token1}`);

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].orgId).toBe(org1.id);
  });

  it('GET /:projectId returns 404 for wrong org', async () => {
    const db = getTestDb();
    const org1 = await createOrg(db);
    const org2 = await createOrg(db);
    const user = await createUser(db, org2.id);
    const token2 = signToken({ org_id: org2.id, user_id: adminId, role: 'admin' });
    const projectId = crypto.randomUUID();

    await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token2}`)
      .send({
        project_id: projectId,
        rep_assignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }],
        contract_value: 25000,
        system_size_kw: 10,
      });

    const token1 = signToken({ org_id: org1.id, user_id: adminId, role: 'admin' });
    const res = await request(app)
      .get(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${token1}`);

    expect(res.status).toBe(404);
  });
});
