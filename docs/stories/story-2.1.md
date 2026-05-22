# Story 2.1: Plans API — CRUD & Versioning

**Epic:** Commission Plan Management
**Status:** Review
**Estimate:** L (3-4 days)
**Depends on:** 1.3 (Auth), 1.6 (Org settings), 1.7 (Ops)
**Blocks:** 2.2 (Plan Assignments), all commission calculation stories

## Context

Commission plans are the core config object. Every commission calculation resolves against a plan. This story adds the full CRUD surface — create, list, update, and version plans — plus the constraints (effective date validation, name uniqueness, immutability when events exist, transactional end-and-replace).

The partial unique index `idx_plans_active_name` (`org_id, name WHERE is_active = true`) was already created in migration 0000 and satisfies FR5 without a new migration.

## User-facing change

- `POST /api/v1/plans` — create plan (admin only)
- `GET /api/v1/plans` — list plans with filters (any role)
- `PUT /api/v1/plans/:id` — update plan (admin; 422 if events exist and immutable fields change)
- `POST /api/v1/plans/:id/end-and-replace` — atomically end plan and create replacement (admin)

## Acceptance Criteria

**AC1 — Create plan**
- POST with valid payload → 201, full plan object, audit_log `plan_created`
- Missing `rules.percent` for percent_contract → 400 field-level Zod error
- `effective_from` in the past → 400 `{ error: 'effective_from_must_be_future' }`
- Duplicate (same org + name + is_active) → 409 `{ error: 'plan_name_conflict' }`
- `rules.percent = 0` or `dollars_per_watt > 50` → 400

**AC2 — List plans**
- GET → ordered by effective_from desc, paginated
- `?is_active=true` filters; `?calculation_type=ppw` filters
- Org scoped — never returns other orgs' plans
- Any role (rep/admin) can list

**AC3 — Update plan**
- PUT name change (no events) → 200, audit_log `plan_updated`
- PUT changing `calculation_type`/`rules` when plan has events → 422 `plan_has_events_immutable_fields`, plan unchanged
- PUT on another org's plan → 404

**AC4 — End-and-replace**
- POST → old plan marked `is_active=false`, `effective_to` set; new plan created inheriting fields; two audit_log rows (`plan_ended`, `plan_created`) in one transaction
- On another org's plan → 404

**"Built Right" gates:**
- Org Scoping: all queries include `org_id = req.auth.org_id` — verified by isolation tests
- Idempotency: POST is not idempotent by design; PUT and end-and-replace are safe to retry
- Calculation correctness: N/A (no money math; plan config only)

## Tasks/Subtasks

- [x] **Task 1: Zod schemas in shared package**
  - [x] Add `zod` dependency to `packages/shared`
  - [x] Create `packages/shared/src/schemas/plans.ts` with discriminated union (percent_contract/ppw)
  - [x] Export from `packages/shared/src/index.ts`

- [x] **Task 2: Plans route**
  - [x] Create `apps/api/src/routes/plans.ts` with `createPlansRouter(db)`
  - [x] `GET /` with is_active, calculation_type, page, limit query params
  - [x] `POST /` — Zod validation, future-date check, DB insert with unique constraint catch → 409
  - [x] `PUT /:id` — org ownership check, event-count guard for immutable fields, update + audit_log
  - [x] `POST /:id/end-and-replace` — transaction: end old plan (`is_active=false`, `effective_to`) + create new from merged fields + two audit_log rows

- [x] **Task 3: Wire into app.ts**
  - [x] Import and mount `createPlansRouter` at `/api/v1/plans`

- [x] **Task 4: Integration tests**
  - [x] Create `apps/api/src/routes/plans.test.ts` (15 tests)
  - [x] AC1: create → 201; missing rules → 400; past effective_from → 400; duplicate → 409; out-of-range percent → 400; out-of-range ppw → 400
  - [x] AC2: list ordered desc; is_active filter; calculation_type filter; org isolation
  - [x] AC3: update name (no events) → 200 + audit_log; update immutable with events → 422; wrong org → 404
  - [x] AC4: end-and-replace → old ended, new created, 2 audit rows; wrong org → 404

- [x] **Task 5: Build and lint**
  - [x] `pnpm build` passes
  - [x] `pnpm lint` clean
  - [x] `pnpm test` — 90 tests pass (50 engine + 10 auth + 6 orgs + 9 ops + 15 plans)

## Implementation notes

- Discriminated union Zod schema: `z.discriminatedUnion('calculation_type', [percentContractSchema, ppwSchema])` in shared — enables field-level errors per calculation type
- FR5 (name conflict): catch DB unique constraint violation on `idx_plans_active_name` — no need for a pre-check query
- FR8 (immutable fields): detect `calculation_type` or `rules` in the update body, then count linked events — 422 if > 0
- end-and-replace: sets `isActive = false` on old plan so the new plan can reuse the same name without conflicting with `idx_plans_active_name`
- `declaration: true` in tsconfig: Drizzle count query result is potentially undefined — use optional chaining + nullish coalescing

## Files to create

- `packages/shared/src/schemas/plans.ts`
- `apps/api/src/routes/plans.ts`
- `apps/api/src/routes/plans.test.ts`

## Files to modify

- `packages/shared/src/index.ts` (export schemas)
- `packages/shared/package.json` (added zod dependency)
- `apps/api/src/app.ts` (mount plans router)

## Dev Agent Record

### Implementation Plan
- Discriminated union Zod schemas in shared package (reusable by web app)
- `isFuture(dateStr)` helper for FR3 check — runs after Zod parse, before DB write
- Unique constraint caught by error message containing `idx_plans_active_name` — 409 returned
- end-and-replace: sets `isActive = false` on old plan to release the unique index slot before creating the new plan in same transaction
- TypeScript: Drizzle `count()` result needs `[0]?.total ?? 0` pattern (array might be undefined)

### Debug Log
- Unused `sql` import in plans.ts → removed (lint error)
- TS2339: Drizzle `count()` result destructuring — fixed with optional chaining

### Completion Notes
- All 15 plans tests pass; all 90 total tests pass
- `pnpm build` and `pnpm lint` both clean
- AC1–AC4 fully covered; org isolation verified

### File List
- `packages/shared/src/schemas/plans.ts` (new)
- `packages/shared/src/index.ts` (updated)
- `packages/shared/package.json` (updated: added zod)
- `apps/api/src/routes/plans.ts` (new)
- `apps/api/src/routes/plans.test.ts` (new)
- `apps/api/src/app.ts` (updated: plans router mounted)
