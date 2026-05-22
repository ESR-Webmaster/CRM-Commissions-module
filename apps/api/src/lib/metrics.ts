import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [registry],
});

export const httpRequestDurationMs = new Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'path'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

export const dbQueryDurationMs = new Histogram({
  name: 'db_query_duration_ms',
  help: 'Database query duration in milliseconds',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [registry],
});

export const commissionEngineDurationMs = new Histogram({
  name: 'commission_engine_duration_ms',
  help: 'Commission engine processing duration in milliseconds',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});
