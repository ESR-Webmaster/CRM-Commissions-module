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
} from '../test/fixtures/engine-fixtures';
import { createAuthMiddleware } from './auth';
import { createUsersRouter } from '../routes/users';
import * as schema from '../db/schema/index';

const TEST_SIGNING_KEY = 'test-jwt-signing-key-for-auth-story-1-3';

function signToken(payload: { org_id: string; user_id: string; role: string }, expiresIn = '1h') {
  return jwt.sign(payload, TEST_SIGNING_KEY, { algorithm: 'HS256', expiresIn });
}

function buildTestApp() {
  const db = getTestDb();
  const app = express();
  app.use(express.json());
  // Unauthenticated
  app.get('/health', (_req, res) => res.json({ ok: true }));
  // Protected
  app.use('/api/v1', createAuthMiddleware(db, TEST_SIGNING_KEY));
  app.use('/api/v1/users', createUsersRouter(db));
  // Minimal echo endpoint to inspect req.auth in tests
  app.get('/api/v1/me', (req, res) => res.json(req.auth));
  return app;
}

describe('Auth middleware & user sync (Story 1.3)', () => {
  let app: ReturnType<typeof buildTestApp>;
  let orgAId: string;
  let orgBId: string;
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
    const orgA = await createOrg(db, { name: 'Org A' });
    const orgB = await createOrg(db, { name: 'Org B' });
    orgAId = orgA.id;
    orgBId = orgB.id;
  });

  // ── AC1: Valid JWT extracts auth context ──────────────────────────────────

  it('AC1: valid JWT → 200 with org_id/user_id/role attached to req.auth', async () => {
    const token = signToken({ org_id: orgAId, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ org_id: orgAId, user_id: adminUserId, role: 'admin' });
  });

  it('AC1: /health is accessible without a token (unprotected route)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  // ── AC2: Invalid JWT returns 401 ─────────────────────────────────────────

  it('AC2a: missing Authorization header → 401', async () => {
    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('AC2b: expired JWT → 401', async () => {
    const token = signToken({ org_id: orgAId, user_id: adminUserId, role: 'admin' }, '-1s');

    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('AC2c: tampered JWT (modified payload) → 401', async () => {
    const token = signToken({ org_id: orgAId, user_id: adminUserId, role: 'admin' });
    const [header, , sig] = token.split('.');
    const maliciousPayload = Buffer.from(
      JSON.stringify({ org_id: orgBId, user_id: 'attacker', role: 'admin' })
    ).toString('base64url');
    const tampered = `${header}.${maliciousPayload}.${sig}`;

    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${tampered}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  // ── AC3: Valid JWT with unknown org → 403 ────────────────────────────────

  it('AC3: valid JWT but org_id not in orgs table → 403 org_not_found', async () => {
    const ghostOrgId = crypto.randomUUID();
    const token = signToken({ org_id: ghostOrgId, user_id: adminUserId, role: 'admin' });

    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'org_not_found' });
  });

  // ── AC4: POST /api/v1/users/sync ─────────────────────────────────────────

  it('AC4a: admin JWT + valid body → upserts users, returns { synced: N }', async () => {
    const token = signToken({ org_id: orgAId, user_id: adminUserId, role: 'admin' });
    const newUsers = [
      { id: crypto.randomUUID(), name: 'Alice', email: 'alice@test.com', role: 'rep' },
      { id: crypto.randomUUID(), name: 'Bob', email: 'bob@test.com', role: 'rep' },
    ];

    const res = await request(app)
      .post('/api/v1/users/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({ users: newUsers });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ synced: 2 });

    const db = getTestDb();
    const rows = await db.select().from(schema.users).where(eq(schema.users.orgId, orgAId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('AC4b: rep JWT → 403 on sync endpoint', async () => {
    const token = signToken({ org_id: orgAId, user_id: repUserId, role: 'rep' });

    const res = await request(app)
      .post('/api/v1/users/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({ users: [{ id: crypto.randomUUID(), name: 'Eve', email: 'eve@test.com', role: 'rep' }] });

    expect(res.status).toBe(403);
  });

  it('AC4c: repeated sync with same user IDs → idempotent, exactly one row in DB', async () => {
    const token = signToken({ org_id: orgAId, user_id: adminUserId, role: 'admin' });
    const userId = crypto.randomUUID();
    const payload = { users: [{ id: userId, name: 'Alice', email: 'alice@test.com', role: 'rep' }] };

    // Send the same payload 3 times
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/v1/users/sync')
        .set('Authorization', `Bearer ${token}`)
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ synced: 1 });
    }

    const db = getTestDb();
    const rows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(rows).toHaveLength(1); // exactly one row — no duplicates
  });

  // ── AC5: Cross-org isolation ──────────────────────────────────────────────

  it('cross-org isolation: rep A token cannot access rep B org data (req.auth.org_id is always from the token)', async () => {
    const db = getTestDb();

    // Seed org B with users
    const orgBUserId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: orgBUserId,
      orgId: orgBId,
      name: 'Rep B',
      email: 'repb@orgb.com',
      role: 'rep',
    });

    // Authenticate as org A
    const tokenA = signToken({ org_id: orgAId, user_id: adminUserId, role: 'admin' });

    // Verify the auth context shows org A — never org B
    const meRes = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.org_id).toBe(orgAId);
    expect(meRes.body.org_id).not.toBe(orgBId);

    // Sync a user under org A's token — result must be scoped to org A
    const syncUserId = crypto.randomUUID();
    await request(app)
      .post('/api/v1/users/sync')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ users: [{ id: syncUserId, name: 'New Rep', email: 'new@orga.com', role: 'rep' }] });

    // Newly synced user belongs to org A
    const orgARows = await db.select().from(schema.users).where(eq(schema.users.orgId, orgAId));
    expect(orgARows.some((r) => r.id === syncUserId)).toBe(true);

    // Org B's data is untouched
    const orgBRows = await db.select().from(schema.users).where(eq(schema.users.orgId, orgBId));
    expect(orgBRows).toHaveLength(1);
    expect(orgBRows[0]!.id).toBe(orgBUserId);
  });
});
