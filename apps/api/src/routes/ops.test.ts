import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getTestDb, closeTestDb, resetDb, createOrg } from '../test/fixtures/engine-fixtures';
import { buildApp } from '../app';

const TEST_SIGNING_KEY = 'test-jwt-signing-key-for-ops-story-1-7';
const TEST_METRICS_TOKEN = 'test-metrics-token';

function signToken(payload: { org_id: string; user_id: string; role: string }) {
  return jwt.sign(payload, TEST_SIGNING_KEY, { algorithm: 'HS256', expiresIn: '1h' });
}

describe('Operational Readiness (Story 1.7)', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  // ── Health endpoints ────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns { status: ok } with HTTP 200', async () => {
      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('/health is accessible without auth token', async () => {
      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /health/ready', () => {
    it('returns { status: ready, db: ok, migration_version } when DB is up', async () => {
      const app = buildApp();
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.db).toBe('ok');
      expect(typeof res.body.migration_version).toBe('string');
    });
  });

  describe('GET /health/version', () => {
    it('returns { version, build_sha, migration_version }', async () => {
      const app = buildApp();
      const res = await request(app).get('/health/version');
      expect(res.status).toBe(200);
      expect(typeof res.body.version).toBe('string');
      expect(typeof res.body.build_sha).toBe('string');
      expect(typeof res.body.migration_version).toBe('string');
    });
  });

  // ── Metrics endpoint ────────────────────────────────────────────────────────

  describe('GET /metrics', () => {
    it('returns Prometheus text when METRICS_TOKEN is not configured', async () => {
      // When no METRICS_TOKEN env var is set, endpoint is open
      const saved = process.env['METRICS_TOKEN'];
      delete process.env['METRICS_TOKEN'];

      const app = buildApp();
      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain('http_requests_total');

      process.env['METRICS_TOKEN'] = saved;
    });

    it('returns 401 when METRICS_TOKEN is set and request has no token', async () => {
      process.env['METRICS_TOKEN'] = TEST_METRICS_TOKEN;
      const app = buildApp();

      const res = await request(app).get('/metrics');

      expect(res.status).toBe(401);
      delete process.env['METRICS_TOKEN'];
    });

    it('returns Prometheus text when METRICS_TOKEN is set and correct token provided', async () => {
      process.env['METRICS_TOKEN'] = TEST_METRICS_TOKEN;
      const app = buildApp();

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${TEST_METRICS_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('http_requests_total');
      delete process.env['METRICS_TOKEN'];
    });
  });

  // ── Rate limiting ───────────────────────────────────────────────────────────

  describe('Rate limiting', () => {
    it('returns 429 after exceeding per-org rate limit', async () => {
      const db = getTestDb();
      const org = await createOrg(db);
      const userId = crypto.randomUUID();
      const token = signToken({ org_id: org.id, user_id: userId, role: 'admin' });

      // Build app with low limit so test doesn't need 100 requests
      const app = buildApp({ rateLimitMax: 5, rateLimitWindowMs: 60_000, signingKey: TEST_SIGNING_KEY });

      const send = () =>
        request(app)
          .get('/api/v1/orgs/me/settings')
          .set('Authorization', `Bearer ${token}`);

      // First 5 should succeed
      for (let i = 0; i < 5; i++) {
        const res = await send();
        expect(res.status).toBe(200);
      }

      // 6th should be rate-limited
      const res = await send();
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('1');
    });

    it('rate limit is per-org — other orgs are not affected', async () => {
      const db = getTestDb();
      const orgA = await createOrg(db, { name: 'Org A' });
      const orgB = await createOrg(db, { name: 'Org B' });
      const userId = crypto.randomUUID();

      const tokenA = signToken({ org_id: orgA.id, user_id: userId, role: 'admin' });
      const tokenB = signToken({ org_id: orgB.id, user_id: userId, role: 'admin' });

      const app = buildApp({ rateLimitMax: 3, rateLimitWindowMs: 60_000, signingKey: TEST_SIGNING_KEY });

      const sendAs = (token: string) =>
        request(app)
          .get('/api/v1/orgs/me/settings')
          .set('Authorization', `Bearer ${token}`);

      // Exhaust org A's limit
      for (let i = 0; i < 3; i++) {
        await sendAs(tokenA);
      }
      const orgALimited = await sendAs(tokenA);
      expect(orgALimited.status).toBe(429);

      // Org B is unaffected
      const orgBRes = await sendAs(tokenB);
      expect(orgBRes.status).toBe(200);
    });
  });
});
