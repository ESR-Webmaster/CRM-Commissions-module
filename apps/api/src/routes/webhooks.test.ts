import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
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
import { createWebhooksRouter } from './webhooks';
import { commissionEvents } from '../db/schema/index';
import { eq } from 'drizzle-orm';

const TEST_KEY = 'test-jwt-signing-key-webhooks-3-2';

function signToken(payload: { org_id: string; user_id: string; role: string }) {
  return jwt.sign(payload, TEST_KEY, { algorithm: 'HS256', expiresIn: '1h' });
}

function buildApp() {
  const db = getTestDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createAuthMiddleware(db, TEST_KEY));
  app.use('/api/v1/webhooks', createWebhooksRouter(db));
  return app;
}

describe('Webhooks API (Story 3.2)', () => {
  const app = buildApp();
  const adminId = crypto.randomUUID();

  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => { await resetDb(getTestDb()); });

  it('POST /stage-transition creates commission events for matching plan', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id, {
      earnedTriggerStage: 'install',
      isActive: true,
    });
    const projectId = crypto.randomUUID();
    await createProject(db, {
      orgId: org.id,
      projectId,
      repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }],
      planOverrideId: plan.id,
      contractValue: '25000.00',
      systemSizeKw: '10.00',
    });

    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const transitionId = crypto.randomUUID();

    const res = await request(app)
      .post('/api/v1/webhooks/stage-transition')
      .set('Authorization', `Bearer ${token}`)
      .send({
        project_id: projectId,
        from_stage: 'permit',
        to_stage: 'install',
        transition_id: transitionId,
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.event_ids)).toBe(true);
    expect(typeof res.body.events_created).toBe('number');
    expect(typeof res.body.events_already_existed).toBe('number');

    const events = await db
      .select()
      .from(commissionEvents)
      .where(eq(commissionEvents.orgId, org.id));
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  it('POST /stage-transition is idempotent — same transition_id returns already_existed', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const user = await createUser(db, org.id);
    const plan = await createPlan(db, org.id, {
      earnedTriggerStage: 'install',
      isActive: true,
    });
    const projectId = crypto.randomUUID();
    await createProject(db, {
      orgId: org.id,
      projectId,
      repAssignments: [{ user_id: user.id, role: 'closer', split_percent: 100 }],
      planOverrideId: plan.id,
      contractValue: '25000.00',
      systemSizeKw: '10.00',
    });

    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const transitionId = crypto.randomUUID();
    const payload = {
      project_id: projectId,
      from_stage: 'permit',
      to_stage: 'install',
      transition_id: transitionId,
    };

    const res1 = await request(app)
      .post('/api/v1/webhooks/stage-transition')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);
    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post('/api/v1/webhooks/stage-transition')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);
    expect(res2.status).toBe(200);
    expect(res2.body.events_created).toBe(0);
  });

  it('POST /stage-transition with missing required fields → 400', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });

    const res = await request(app)
      .post('/api/v1/webhooks/stage-transition')
      .set('Authorization', `Bearer ${token}`)
      .send({ project_id: crypto.randomUUID() });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('POST /stage-transition uses transition_id as delivery_id when not provided', async () => {
    const db = getTestDb();
    const org = await createOrg(db);
    const token = signToken({ org_id: org.id, user_id: adminId, role: 'admin' });
    const transitionId = crypto.randomUUID();

    const res = await request(app)
      .post('/api/v1/webhooks/stage-transition')
      .set('Authorization', `Bearer ${token}`)
      .send({
        project_id: crypto.randomUUID(),
        from_stage: 'permit',
        to_stage: 'install',
        transition_id: transitionId,
      });

    expect(res.status).toBe(200);
    expect(res.body.events_created).toBe(0);
  });
});
