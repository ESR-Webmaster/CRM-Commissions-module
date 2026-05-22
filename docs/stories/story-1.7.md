# Story 1.7: Operational Readiness

**Epic:** Foundation
**Status:** Review
**Estimate:** L (3-4 days)
**Depends on:** 1.3 (Auth middleware), 1.6 (Org settings API)
**Blocks:** Epic 2 (production deployability assumed)

## Context

Before any Epic 2 stories can run in production, the API needs observability, rate limiting, and a clean shutdown path. This story wires `pino-http` request logging, `express-rate-limit` per-org throttling, Prometheus metrics via `prom-client`, extended health endpoints, and SIGTERM-based graceful shutdown.

## User-facing change

- `GET /health/ready` — DB connectivity + migration version check
- `GET /health/version` — version + build SHA
- `GET /metrics` — Prometheus output (protected by `METRICS_TOKEN` if set)
- Per-org rate limiting: 100 req/s per org, 429 + `Retry-After: 1` on breach
- Structured JSON request logging per request (request_id, method, path, status_code, duration_ms, org_id, user_id)
- Graceful shutdown on SIGTERM (30 s drain, then force-exit)

## Acceptance Criteria

**AC1 — /health endpoints**
- `GET /health` → 200 `{ status: 'ok' }` (already existed, remains unauthenticated)
- `GET /health/ready` → 200 `{ status: 'ready', db: 'ok', migration_version }` when DB up; 503 when DB unreachable
- `GET /health/version` → 200 `{ version, build_sha, migration_version }`

**AC2 — Request logging**
- pino-http middleware emits a JSON log line per request with: `request_id` (UUID), `method`, `path`, `status_code`, `duration_ms`, `org_id` (from JWT), `user_id` (from JWT)
- request_id propagated via `AsyncLocalStorage` — readable anywhere in the call stack
- No `console.log` anywhere in production code (ESLint `no-console` rule enforced)

**AC3 — Rate limiting**
- `express-rate-limit` on all `/api/v1/*` routes
- Keyed on `req.auth.org_id` (falling back to `req.ip`)
- Default: 100 req/s per org; 101st request → 429 with `Retry-After: 1`
- Other orgs' quotas are unaffected when one org is throttled

**AC4 — Prometheus metrics**
- `GET /metrics` returns Prometheus text with counters/histograms for: `http_requests_total`, `http_request_duration_ms`, `db_query_duration_ms`, `commission_engine_duration_ms`
- Protected by `METRICS_TOKEN` Bearer token when env var is set; open when unset (local dev)
- Documented in `.env.example`

**AC5 — Graceful shutdown**
- Process handles `SIGTERM` (and `SIGINT`)
- Stops accepting connections, drains in-flight requests, closes DB pool, exits 0
- Force-exits after 30 s if drain stalls
- Logs `{ event: 'shutdown', reason: 'SIGTERM' }` before exit

**"Built Right" gates:**
- Org Scoping: rate limit key is `req.auth.org_id` — other orgs are never throttled by one org's traffic
- No `console.*` in production code — enforced via ESLint rule

## Tasks/Subtasks

- [x] **Task 1: Install dependencies**
  - [x] Add `pino-http`, `express-rate-limit`, `prom-client` to `apps/api` dependencies

- [x] **Task 2: Request logger middleware**
  - [x] Create `apps/api/src/middleware/requestLogger.ts`
  - [x] pino-http with custom serializers (method, url, id only — no full object dump)
  - [x] `customProps(req)` appends `request_id`, `org_id`, `user_id` to each log line
  - [x] `AsyncLocalStorage` for request ID propagation throughout call stack
  - [x] `requestIdMiddleware` binds request ID into `AsyncLocalStorage` after pino-http sets `req.id`

- [x] **Task 3: Rate limiter middleware**
  - [x] Create `apps/api/src/middleware/rateLimiter.ts` as factory `createRateLimiter(opts)`
  - [x] Key: `req.auth?.org_id ?? req.ip ?? 'unknown'`
  - [x] Default: `windowMs: 1000, max: 100`; `handler` sets `Retry-After: 1` and returns 429

- [x] **Task 4: Prometheus metrics**
  - [x] Create `apps/api/src/lib/metrics.ts` with isolated registry
  - [x] Metrics: `http_requests_total`, `http_request_duration_ms`, `db_query_duration_ms`, `commission_engine_duration_ms`
  - [x] `collectDefaultMetrics` registered on same registry

- [x] **Task 5: Health and metrics routes**
  - [x] Create `apps/api/src/routes/health.ts`
  - [x] `GET /` → `{ status: 'ok' }`
  - [x] `GET /ready` → DB ping + migration version from `drizzle_migrations` table
  - [x] `GET /version` → `npm_package_version`, `BUILD_SHA`, migration version
  - [x] `createMetricsHandler()` checks `METRICS_TOKEN` Bearer token when env var is set

- [x] **Task 6: Wire into app.ts**
  - [x] Refactor to `buildApp(opts?)` factory — accepts `rateLimitMax`, `rateLimitWindowMs`, `signingKey` for test injection
  - [x] Mount pino-http + requestIdMiddleware before all routes
  - [x] Mount HTTP metrics tracking middleware (counter + histogram on res finish)
  - [x] Mount health router at `/health`, metrics handler at `/metrics`
  - [x] Mount rate limiter after auth middleware on `/api/v1`
  - [x] Export `app = buildApp()` for backward compatibility

- [x] **Task 7: Graceful shutdown in index.ts**
  - [x] Replace `console.log` with `rootLogger`
  - [x] Create `http.Server` explicitly; listen, handle SIGTERM + SIGINT
  - [x] `server.close()` → drain; 30 s timeout force-exits with code 1

- [x] **Task 8: Remove console.* from production code**
  - [x] Add `no-console: 'error'` to `.eslintrc.cjs` (with override for test files)
  - [x] Replace `console.log/error` in `seed.ts` with pino logger
  - [x] Replace `console.log/error` in `migrate.ts` with pino logger
  - [x] Document `METRICS_TOKEN` in `.env.example`

- [x] **Task 9: Integration tests**
  - [x] Create `apps/api/src/routes/ops.test.ts`
  - [x] AC1: GET /health → 200; GET /health/ready → 200 with migration_version; GET /health/version → 200
  - [x] AC4: GET /metrics without token (token unset) → 200 prometheus text; with wrong token → 401; with correct token → 200
  - [x] AC3: 6 requests with max=5 → 5 succeed + 1 returns 429 with Retry-After: 1
  - [x] AC3: per-org isolation — org A exhausted doesn't affect org B

- [x] **Task 10: Build and lint validation**
  - [x] `pnpm build` passes (no TypeScript errors)
  - [x] `pnpm lint` clean (no-console enforced, no unused vars)
  - [x] `pnpm test` — all 75 tests pass (50 engine + 10 auth + 6 orgs + 9 ops)

## Implementation notes

- `buildApp(opts)` factory replaces the bare `const app = express()` — lets tests inject signing key and rate limit config without monkey-patching env vars
- pino-http `serializers.req` is scoped to `{ method, url, id }` — prevents dumping the full Express request object (circular, huge)
- `METRICS_TOKEN`: if env var unset → open (local dev only); if set → requires `Authorization: Bearer <token>`
- Migration version queried from `drizzle_migrations` table via `SELECT hash FROM drizzle_migrations ORDER BY created_at DESC LIMIT 1`
- `declaration: true` in tsconfig makes `HttpLogger` from pino-http unportable — cast as Express `RequestHandler` to satisfy the build constraint

## Files to create

- `apps/api/src/middleware/requestLogger.ts`
- `apps/api/src/middleware/rateLimiter.ts`
- `apps/api/src/lib/metrics.ts`
- `apps/api/src/routes/health.ts`
- `apps/api/src/routes/ops.test.ts`

## Files to modify

- `apps/api/src/app.ts` (full rewrite to `buildApp` factory)
- `apps/api/src/index.ts` (graceful shutdown, pino logger)
- `apps/api/src/db/seed.ts` (console → pino)
- `apps/api/src/db/migrate.ts` (console → pino)
- `apps/api/package.json` (added pino-http, express-rate-limit, prom-client)
- `.eslintrc.cjs` (added no-console rule + test file override)
- `.env.example` (added METRICS_TOKEN, LOG_LEVEL, BUILD_SHA docs)

## Dev Agent Record

### Implementation Plan
- Factory pattern `buildApp(opts)` with injectable `signingKey`, `rateLimitMax`, `rateLimitWindowMs` for testability
- pino-http configured with compact serializers to prevent full request object dumps
- METRICS_TOKEN: open when unset (dev), required when set (prod)
- TypeScript TS2742 workaround: cast pino-http middleware as `RequestHandler` (declaration:true prevents portable HttpLogger inference)
- exactOptionalPropertyTypes fix: spread conditionally rather than passing `undefined` values to `createRateLimiter`
- ESLint no-console override for `**/*.test.ts` and `**/test/**/*.ts` — test fixtures not production code

### Debug Log
- TS2742 on `httpLogger`: `declaration: true` in tsconfig.base.json makes pino-http's inferred type non-portable. Fixed by annotating as `RequestHandler`.
- TS2379 on `createRateLimiter` call: `exactOptionalPropertyTypes: true` rejects `{ max: undefined }`. Fixed by conditional spreading.
- pino-http dumped full req object: `wrapSerializers: false` was the culprit (removed). Added explicit `serializers.req` to compact to `{ method, url, id }`.
- seed.ts and migrate.ts had `console.log/error` — replaced with pino loggers.

### Completion Notes
- All 75 tests pass: 50 engine + 10 auth + 6 orgs + 9 ops
- `pnpm build` and `pnpm lint` both clean
- AC1–AC5 covered; graceful shutdown implemented (manual testing required for SIGTERM behavior)

### File List
- `apps/api/src/middleware/requestLogger.ts` (new)
- `apps/api/src/middleware/rateLimiter.ts` (new)
- `apps/api/src/lib/metrics.ts` (new)
- `apps/api/src/routes/health.ts` (new)
- `apps/api/src/routes/ops.test.ts` (new)
- `apps/api/src/app.ts` (rewritten: buildApp factory)
- `apps/api/src/index.ts` (updated: graceful shutdown, pino logger)
- `apps/api/src/db/seed.ts` (updated: console → pino)
- `apps/api/src/db/migrate.ts` (updated: console → pino)
- `apps/api/package.json` (updated: added pino-http, express-rate-limit, prom-client)
- `.eslintrc.cjs` (updated: no-console rule + test override)
- `.env.example` (updated: added METRICS_TOKEN, LOG_LEVEL, BUILD_SHA)
