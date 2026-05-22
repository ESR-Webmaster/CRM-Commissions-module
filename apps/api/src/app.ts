import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { db } from './db/index';
import { createAuthMiddleware } from './middleware/auth';
import { httpLogger, requestIdMiddleware } from './middleware/requestLogger';
import { createRateLimiter } from './middleware/rateLimiter';
import { createUsersRouter } from './routes/users';
import { createOrgsRouter } from './routes/orgs';
import { createPlansRouter } from './routes/plans';
import { createAssignmentsRouter } from './routes/assignments';
import { createProjectsRouter } from './routes/projects';
import { createEventsRouter } from './routes/events';
import { createWebhooksRouter } from './routes/webhooks';
import { createStatementsRouter } from './routes/statements';
import { createAuditRouter } from './routes/audit';
import { createAdjustmentsRouter } from './routes/adjustments';
import { createOverrideRulesRouter } from './routes/overrideRules';
import { createDevTokenRouter } from './routes/devToken';
import { createHealthRouter, createMetricsHandler } from './routes/health';
import { createDocusealConfigRouter } from './routes/docuseal/config';
import { createDocusealTemplatesRouter } from './routes/docuseal/templates';
import { createDocusealSubmissionsRouter } from './routes/docuseal/submissions';
import { createDocusealBulkSendRouter } from './routes/docuseal/bulkSend';
import { httpRequestsTotal, httpRequestDurationMs } from './lib/metrics';

export function buildApp(opts: { rateLimitMax?: number; rateLimitWindowMs?: number; signingKey?: string } = {}): Express {
  const app = express();

  app.use(express.json());
  app.use(httpLogger);
  app.use(requestIdMiddleware as (req: Request, res: Response, next: NextFunction) => void);

  // Track HTTP metrics for all routes
  app.use((req: Request, res: Response, next: NextFunction) => {
    const end = httpRequestDurationMs.startTimer({ method: req.method, path: req.path });
    res.on('finish', () => {
      httpRequestsTotal.inc({ method: req.method, path: req.path, status: String(res.statusCode) });
      end();
    });
    next();
  });

  // Unauthenticated health checks and metrics
  app.use('/health', createHealthRouter(db));
  app.get('/metrics', createMetricsHandler());

  // Dev-only token endpoint — blocked in production
  if (process.env['NODE_ENV'] !== 'production') {
    const devKey = opts.signingKey ?? process.env['JWT_SIGNING_KEY'];
    if (devKey) {
      app.use('/dev/token', createDevTokenRouter(db, devKey));
    }
  }

  // All /api/v1 routes require a valid JWT scoped to a real org
  const authMiddleware = createAuthMiddleware(db, opts.signingKey);
  app.use('/api/v1', authMiddleware);
  const rateLimiterOpts = {
    ...(opts.rateLimitMax !== undefined && { max: opts.rateLimitMax }),
    ...(opts.rateLimitWindowMs !== undefined && { windowMs: opts.rateLimitWindowMs }),
  };
  app.use('/api/v1', createRateLimiter(rateLimiterOpts));

  app.use('/api/v1/users', createUsersRouter(db));
  app.use('/api/v1/orgs', createOrgsRouter(db));
  app.use('/api/v1/plans', createPlansRouter(db));
  app.use('/api/v1/plan-assignments', createAssignmentsRouter(db));
  app.use('/api/v1/projects', createProjectsRouter(db));
  app.use('/api/v1/webhooks', createWebhooksRouter(db));
  app.use('/api/v1/events', createEventsRouter(db));
  app.use('/api/v1/statements', createStatementsRouter(db));
  app.use('/api/v1/audit', createAuditRouter(db));
  app.use('/api/v1/adjustments', createAdjustmentsRouter(db));
  app.use('/api/v1/override-rules', createOverrideRulesRouter(db));
  app.use('/api/v1/docuseal/config', createDocusealConfigRouter(db));
  app.use('/api/v1/docuseal/templates', createDocusealTemplatesRouter(db));
  app.use('/api/v1/docuseal/submissions', createDocusealSubmissionsRouter(db));
  app.use('/api/v1/docuseal/bulk-send', createDocusealBulkSendRouter(db));

  return app;
}

export const app = buildApp();
