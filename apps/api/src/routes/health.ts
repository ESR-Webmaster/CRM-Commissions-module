import { Router } from 'express';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index';
import { registry } from '../lib/metrics';

async function getMigrationVersion(db: Db): Promise<string> {
  try {
    const rows = await db.execute(
      sql`SELECT hash FROM drizzle_migrations ORDER BY created_at DESC LIMIT 1`
    );
    const first = rows[0] as { hash?: string } | undefined;
    return first?.hash ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createHealthRouter(db: Db): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res): Promise<void> => {
    try {
      await db.execute(sql`SELECT 1`);
      const migrationVersion = await getMigrationVersion(db);
      res.json({ status: 'ready', db: 'ok', migration_version: migrationVersion });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      res.status(503).json({ status: 'not_ready', db: 'error', detail });
    }
  });

  router.get('/version', async (_req, res): Promise<void> => {
    const migrationVersion = await getMigrationVersion(db);
    res.json({
      version: process.env['npm_package_version'] ?? '0.0.0',
      build_sha: process.env['BUILD_SHA'] ?? 'dev',
      migration_version: migrationVersion,
    });
  });

  return router;
}

export function createMetricsHandler() {
  return async (req: import('express').Request, res: import('express').Response): Promise<void> => {
    const metricsToken = process.env['METRICS_TOKEN'];
    if (metricsToken) {
      const authHeader = req.headers['authorization'] ?? '';
      if (authHeader !== `Bearer ${metricsToken}`) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }
    const output = await registry.metrics();
    res.setHeader('Content-Type', registry.contentType);
    res.send(output);
  };
}
