# Story 1.4: Commission engine service

**Epic:** Engine
**Status:** Review
**Estimate:** L (5-7 days)
**Depends on:** 1.2 (DB schema), 1.3 (Auth middleware)
**Blocks:** 1.5 (Webhook handler), 1.10 (Rep dashboard API), every UI story that displays computed amounts

## Context

This is the heart of the product. Get it wrong and every dollar paid out is wrong. The engine is what the webhook handler will call (Story 1.5) when Sunscape POSTs a stage transition. It is also called in dry-run mode by the "projected commission" preview endpoint (Story 1.7).

Two things must be true of every code change to this service:

1. **Idempotency.** Same input must never produce duplicate events. The DB schema already enforces this via unique constraint, but the service must handle the resulting error gracefully (catch, return existing event IDs).
2. **The ledger is immutable.** The engine only INSERTs into `commission_events`. It never UPDATEs them. Corrections are new events with negative amounts.

Reference: `docs/architecture.md` section "Commission engine"; `docs/prd.md` section 6 (edge cases the engine must handle correctly).

## User-facing change

None directly. The engine is internal. Reps will see its output via the dashboard (Story 1.10+).

## Acceptance criteria

### Service contract

A class or set of pure functions at `/apps/api/src/services/commissionEngine.ts` exposes:

```ts
async function processStageTransition(input: StageTransitionInput): Promise<EngineResult>
async function previewProjectedCommission(input: PreviewInput): Promise<PreviewResult>
```

Where:

```ts
type StageTransitionInput = {
  org_id: string;
  project_id: string;
  from_stage: string;
  to_stage: string;
  transition_id: string;       // idempotency key from Sunscape
  delivery_id: string;         // webhook delivery id (also idempotency)
  occurred_at: Date;
};

type EngineResult = {
  events_created: CommissionEventRow[];
  events_already_existed: CommissionEventRow[]; // for idempotent replay
};

type PreviewInput = {
  org_id: string;
  project_id: string;
  hypothetical_stage: string;  // "what would happen if project advanced to this stage?"
};

type PreviewResult = {
  would_create: Array<{
    user_id: string;
    plan_id: string;
    event_type: 'earned' | 'override_earned';
    amount: number;
    calculation_explanation: string;
  }>;
};
```

### Engine flow (matches architecture doc exactly)

1. Look up `project_commission_configs` for `project_id`. If not found, return empty result with no error (engine is fine with projects that don't have configs yet).
2. For each rep in `rep_assignments`:
   a. Resolve the applicable plan: `plan_override_id` if set on the project, otherwise the active `plan_assignment` for this user at `occurred_at` for the rep's role.
   b. If no plan resolves, skip this rep silently (log a warning).
   c. If `to_stage == plan.earned_trigger_stage`: calculate the amount via the plan's `calculation_type`, apply rep's `split_percent`, insert an `earned` event.
3. For each `earned` event just created, look up applicable `override_rules` (matching `manager_user_id` → rep, applicable plan, within effective dates) and insert `override_earned` events.
4. **Clawback handling (per-plan, only if `clawback_config.enabled`):**
   - For each plan touched by this project, check `clawback_config`.
   - If `to_stage ∈ clawback_config.cancellation_stages`:
     - Find prior `earned` and `override_earned` events for this project under this plan, with `status != 'clawed_back'` and within `clawback_config.grace_period_days` of `occurred_at`.
     - For each, write a `clawed_back` event with amount = `-(original_amount * clawback_config.clawback_percent / 100)`.
   - If `clawback_config.enabled` is false or `clawback_config` is null: do nothing on cancellation.
5. Status defaults: read org's `settings.require_event_approval`. If true, new events have `status = 'pending'`. If false, `status = 'approved'`.
6. Write audit_log entries for every event created.

### Calculation rules

- `percent_contract`: `amount = contract_value * (rules.percent / 100) * (split_percent / 100)`
- `ppw`: `amount = (system_size_kw * 1000) * rules.dollars_per_watt * (split_percent / 100)`
- `tiered`, `hybrid`: throw `NotImplementedError` in v1. Schema supports them; engine doesn't.

All math uses `Decimal` (decimal.js or similar). NEVER use JS numbers for money — floating point will bite you. Final amount stored in DB is rounded to 2 decimal places using banker's rounding.

### Override rules

- A manager's `override_earned` amount = `earned_event.amount * (override_rule.override_percent / 100)`.
- Multiple override rules for the same manager + plan: pick the most specific (one with `applies_to_plan_ids` set wins over a general "all plans" rule). If still tied, pick the most recently created.
- `team_member_user_ids` empty array means "no team members" — no event fires. Null means "all team members under this manager" — but v1 doesn't have a team hierarchy concept, so treat null as empty for v1.

### Idempotency

- Engine catches the Postgres unique constraint violation on `(triggering_stage_transition_id, user_id, event_type)` and returns the existing event ID instead.
- Tested by calling the engine twice with the same input and asserting no duplicate rows.
- The `delivery_id` is also stored as a column on each event for replay debugging.

### Audit logging

- Every event creation writes an `audit_log` row: `entity_type='commission_event'`, `action='created'`, `before=null`, `after=<event row>`.
- The engine itself does not modify event status — that's the approval API in a later story. So no `updated` audit rows come from the engine.

### Error handling

- If `contract_value` or `system_size_kw` is missing/zero/negative on `project_commission_configs`: engine returns an explicit error, does NOT write any event. The API webhook handler will return 400.
- If a plan's `rules` jsonb is malformed for its `calculation_type`: engine throws `MalformedPlanRulesError`. Webhook handler returns 500.
- All other unexpected errors: engine throws, transaction rolls back, no partial state.

### Transactions

- All event writes for a single `processStageTransition` call happen in a single Postgres transaction. Either everything happens or nothing does. Use Drizzle's `db.transaction()`.

## Tests (mandatory — this story does not ship without them)

Unit tests in `/apps/api/src/services/commissionEngine.test.ts`. Use Vitest. Each test is a discrete scenario from `docs/prd.md` section 6:

1. **Single rep, percent plan, hits earned trigger** → one `earned` event with correct amount.
2. **Single rep, ppw plan, hits earned trigger** → one `earned` event, watts × dollars/W.
3. **Stage transition that doesn't match any plan's trigger** → no events created.
4. **Same transition_id submitted twice** → second call returns the same event IDs as the first, no duplicates in DB.
5. **Project with two reps (one closer, one setter on different plans)** → two events, one per rep, each at their own plan's rates.
6. **Plan version transition mid-pipeline** → engine uses the plan that was active at `project_commission_configs.created_at`, not the latest.
7. **Override rule fires after earned event** → manager gets `override_earned` event at the configured percentage.
8. **Cancellation stage hit, plan has clawback enabled within grace period** → `clawed_back` event with negative amount equal to `clawback_percent` of original.
9. **Cancellation stage hit, plan has clawback enabled but past grace period** → no clawback event.
10. **Cancellation stage hit, plan has clawback disabled** → no clawback event even though the project was cancelled.
11. **Cancellation stage hit but org has multiple plans on the project, one with clawback and one without** → clawback fires only on the plan that has it enabled.
12. **Rep removed from project's `rep_assignments` before trigger fires** → removed rep does not earn.
13. **Rep added to project's `rep_assignments` after trigger already fired** → new rep does not retroactively earn.
14. **`contract_value` is null** → engine returns error, no event written.
15. **Org's `require_event_approval` is true** → new events have status `pending`. Toggle to false on the same org → new events have status `approved`, existing pending events untouched.
16. **Money math precision: contract_value = 12345.67, percent = 3.33, split = 33.33** → result matches a hand-calculation to the cent.
17. **Concurrent calls with the same transition_id from two API workers** → only one event row ends up in the DB; both calls return the same event ID. (Use a test harness that fires two engine calls concurrently.)

All tests run against a real Postgres (in docker-compose), not mocks. Reset DB state between tests via the seed reset.

## Implementation notes

- Use `decimal.js` for all money math. Wrap Postgres `numeric` reads to construct Decimals. Multiply, then round at the end, never in intermediate steps.
- Banker's rounding (round half to even): `dec.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN)`.
- The engine is a pure-ish service: it takes a DB transaction handle, reads, writes, returns. No side effects beyond the DB. No HTTP, no logging libraries that aren't injected. This makes it testable.
- Use a structured logger (pino) injected via constructor or argument. Engine logs every decision point at `debug` level (which plan resolved, what amount calculated, idempotency hits). Production runs at `info`; tests run at `debug` so failures are diagnosable.
- Don't optimize prematurely. Per-rep loops with separate queries are fine in v1. We'll batch later if `n` reps per project ever exceeds 5 in production (unlikely).
- The `calculation_explanation` field on the preview result is for the UI to show ("3% of $25,000 = $750"). Write it as a templated string in the engine; do NOT compute it in the frontend.

## Files to create

- `/apps/api/src/services/commissionEngine.ts`
- `/apps/api/src/services/commissionEngine.test.ts`
- `/apps/api/src/services/types.ts` (input/output types)
- `/apps/api/src/services/calculators/percentContract.ts`
- `/apps/api/src/services/calculators/ppw.ts`
- `/apps/api/src/services/calculators/index.ts`
- `/apps/api/src/services/errors.ts` (custom error classes)
- `/apps/api/test/fixtures/engine-fixtures.ts` (seed data for engine tests)

## QA gate

QA agent verifies:
1. All 17 unit tests pass.
2. Run a 1000-event soak test: generate 1000 unique stage transitions in a loop, assert exactly 1000 events written, no duplicates, no orphan audit rows.
3. Run a 100-iteration replay test: pick 100 transition_ids, submit each 5 times concurrently, assert exactly 100 events total.
4. Hand-verify 5 scenarios end-to-end against a calculator (have the dev pair with the QA agent on a spreadsheet).
5. Code review: no `any`, no money math in JS numbers, every public function has a JSDoc explaining its purpose and contract.

## Handoff to next story

Story 1.5 (Stage transition webhook handler) wraps this service in an HTTP endpoint with Zod validation, auth, and audit logging at the API layer. Engine itself is auth-agnostic — the handler does the org-scoping check.

Story 1.7 (Project commission preview API) wraps the engine's `previewProjectedCommission` in a GET endpoint.

The rep dashboard (Story 1.10) reads `commission_events` directly via the events query API (Story 1.8) — it does not call the engine. The engine is write-side only; the read side is plain queries.

## Dev Agent Record

### Implementation Plan
- Schema change: added `delivery_id` (text, nullable) to `commission_events` in `events.ts`; generated migration `0001_peaceful_ravenous.sql` with updated immutability trigger function
- Renamed `rate_per_watt` → `dollars_per_watt` in `CommissionRules` interface across schema, shared types, and seed
- Engine functions `processStageTransition` and `previewProjectedCommission` are plain exports (not class), accepting `(input, db, logger)` — no side effects beyond DB
- Idempotency via `INSERT ... ON CONFLICT DO NOTHING RETURNING *`; on conflict, fetches existing row from DB
- All writes (earned + override_earned + clawed_back + audit_log) happen in one `db.transaction()` per call
- Money math: Decimal.js throughout; `toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN)` at final step only
- `SYSTEM_ACTOR` constant `'00000000-0000-0000-0000-000000000000'` used as `created_by` / `actor_user_id` for system-generated events
- Fixtures placed in `src/test/fixtures/engine-fixtures.ts` (not `test/fixtures/`) — Vitest's CJS fork mode only hooks TypeScript resolution for files under the tsconfig `rootDir` (`src/`)

### Debug Log
- `created_by` column is `uuid` type — passing string `'system'` caused Postgres error. Fixed: introduced `SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000'`
- Import path `@sunscape/shared` doesn't exist — workspace package is `@sunscape/commissions-shared`. Fixed import in `types.ts`
- `tsconfig.build.json` wasn't excluding `*.test.ts` and `test/**/*` — caused build error from test importing fixture outside `rootDir`. Fixed: added exclude entries
- Vitest `pool: 'forks'` CJS mode cannot resolve `.ts` files via `require()` from outside `src/`. Fixed: moved fixture to `src/test/fixtures/` (relative paths all inside `rootDir` now)
- After `pnpm build` produced `dist/` artifacts, tests broke because Vitest's module resolution picked up stale compiled `.js` — fixed by ensuring fixture lives inside `src/`

### Completion Notes
- All 17 unit tests pass (including concurrent-call test 17)
- Engine handles: earned, override_earned, clawed_back, idempotent replay, multi-rep projects, plan version transitions, grace period clawbacks, org approval flag
- `previewProjectedCommission` implemented (read-only dry-run)
- `pnpm build` and `pnpm lint` clean after all changes
- `db/migrations/0001_peaceful_ravenous.sql` applied to Docker Postgres and registered in `drizzle.__drizzle_migrations`

### File List
- `apps/api/src/db/schema/events.ts` (updated: added `deliveryId` column)
- `apps/api/src/db/schema/plans.ts` (updated: `rate_per_watt` → `dollars_per_watt` in `CommissionRules`)
- `apps/api/src/db/seed.ts` (updated: `rate_per_watt` → `dollars_per_watt`)
- `apps/api/src/services/types.ts` (new)
- `apps/api/src/services/errors.ts` (new)
- `apps/api/src/services/calculators/percentContract.ts` (new)
- `apps/api/src/services/calculators/ppw.ts` (new)
- `apps/api/src/services/calculators/index.ts` (new)
- `apps/api/src/services/commissionEngine.ts` (new)
- `apps/api/src/services/commissionEngine.test.ts` (new)
- `apps/api/src/test/fixtures/engine-fixtures.ts` (new — inside src/ for Vitest CJS resolution)
- `apps/api/vitest.config.ts` (new)
- `apps/api/package.json` (updated: added decimal.js, pino, vitest deps; added `test` script)
- `apps/api/tsconfig.build.json` (updated: exclude `src/**/*.test.ts` and `test/**/*`)
- `db/migrations/0001_peaceful_ravenous.sql` (new — adds delivery_id, replaces immutability trigger)
- `db/migrations/meta/_journal.json` (updated by drizzle-kit)
- `packages/shared/src/db-types.ts` (updated: `deliveryId` on `CommissionEvent`, `dollars_per_watt` in `CommissionRules`)
