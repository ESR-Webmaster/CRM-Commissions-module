# Story 1.6: Org Settings API

**Epic:** Foundation
**Status:** Review
**Estimate:** S (1 day)
**Depends on:** 1.3 (Auth middleware), 1.4 (Engine core)
**Blocks:** 1.7 (Ops readiness), all stories that need org settings

## Context

The commission engine already reads `require_event_approval` from the `orgs.settings` JSONB column (Story 1.4). This story adds the API surface so org admins can view and update that setting without direct DB access.

Two invariants:
1. Only admins may mutate settings — reps get 403.
2. Toggling `require_event_approval` is non-retroactive: existing `pending` events keep their status; only new events respect the updated setting.

## User-facing change

- `GET /api/v1/orgs/me/settings` — returns current org settings
- `PATCH /api/v1/orgs/me/settings` — updates `require_event_approval` (admin only)

## Acceptance Criteria

**AC1 — GET returns current settings**
Given a valid JWT (any role)
When `GET /api/v1/orgs/me/settings` is called
Then the response is `{ require_event_approval: boolean }` scoped to the JWT's org_id

**AC2 — PATCH updates setting and writes audit_log**
Given a valid admin JWT and payload `{ require_event_approval: false }`
When `PATCH /api/v1/orgs/me/settings` is called
Then the org's `settings.require_event_approval` is updated in the database
And the response echoes the updated settings object
And an `audit_log` row is written with `entity_type='org'`, `action='settings_updated'`, `before`/`after` containing the settings objects

**AC3 — Non-admin PATCH returns 403**
Given a JWT with role `rep`
When `PATCH /api/v1/orgs/me/settings` is called
Then the API returns 403
And no audit_log row is written
And the settings remain unchanged

**AC4 — Toggle is non-retroactive**
Given existing `pending` commission events and `require_event_approval = true`
When `PATCH` is called with `{ require_event_approval: false }`
Then existing pending events retain their `pending` status
And new events created after the toggle have `status = 'approved'`

**AC5 — Invalid body returns 400**
Given a PATCH with `{ require_event_approval: "yes" }` (string, not boolean)
When Zod validates the request
Then the API returns 400 with `{ error: 'invalid_request', details: ... }` before any DB write

**"Built Right" gates for this story:**
- Org Scoping: settings are read/written scoped to JWT org_id — never from request body
- State Machine: N/A
- Idempotency: PATCH is idempotent — same value patched twice produces identical state
- Calculation correctness: N/A (no money math)

## Tasks/Subtasks

- [x] **Task 1: Create orgs route**
  - [x] Create `apps/api/src/routes/orgs.ts` with factory `createOrgsRouter(db)`
  - [x] `GET /me/settings` — query orgs table, return `{ require_event_approval }`
  - [x] `PATCH /me/settings` — requireAdmin guard, Zod validation, merge settings, update DB, write audit_log, echo response

- [x] **Task 2: Wire route into app.ts**
  - [x] Import `createOrgsRouter` and mount at `/api/v1/orgs`

- [x] **Task 3: Integration tests**
  - [x] Create `apps/api/src/routes/orgs.test.ts`
  - [x] AC1: GET with require_event_approval = false → { require_event_approval: false }
  - [x] AC1: GET with require_event_approval = true → { require_event_approval: true }
  - [x] AC2: admin PATCH → 200, DB updated, audit_log written with before/after
  - [x] AC3: rep PATCH → 403, no audit_log, setting unchanged
  - [x] AC5: invalid body → 400 with Zod details
  - [x] AC4: non-retroactive — pending events stay pending; new events get approved

- [x] **Task 4: Build and lint validation**
  - [x] `pnpm build` passes
  - [x] `pnpm lint` clean
  - [x] `pnpm test` — all 66 tests pass (50 engine + 10 auth + 6 orgs)

## Implementation notes

- Route factory `createOrgsRouter(db)` follows same pattern as `createUsersRouter`
- Admin guard: reuses `requireAdmin` middleware from `middleware/auth.ts`
- Settings merge: `{ ...before, ...parsed.data }` to preserve any future settings keys
- Audit log: `entityType = 'org'`, `entityId = org_id`, `actorUserId = req.auth.user_id`
- Non-retroactive is naturally enforced: the engine reads `require_event_approval` at transition time; the immutability trigger on commission_events prevents retroactive updates

## Files to create

- `apps/api/src/routes/orgs.ts`
- `apps/api/src/routes/orgs.test.ts`

## Files to modify

- `apps/api/src/app.ts` (mount orgs router)

## Dev Agent Record

### Implementation Plan
- Factory pattern `createOrgsRouter(db)` — injectable DB for testability
- `GET /me/settings`: single DB query on orgs table, returns settings with `?? false` default
- `PATCH /me/settings`: fetch existing, merge, update, write audit_log in two sequential inserts
- `requireAdmin` reused from auth middleware — no new guards needed
- Tests use supertest + real Postgres, same pattern as auth.test.ts
- AC4 (non-retroactive) tested end-to-end: fire engine transition before and after toggle, verify status differences

### Completion Notes
- All 6 orgs tests pass; 60 prior tests continue to pass (66 total)
- `pnpm build` and `pnpm lint` both clean
- AC1–AC5 fully covered

### File List
- `apps/api/src/routes/orgs.ts` (new)
- `apps/api/src/routes/orgs.test.ts` (new)
- `apps/api/src/app.ts` (updated: added orgs router import and mount)
