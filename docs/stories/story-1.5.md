# Story 1.5: Commission Engine — 50-Scenario Golden Suite

**Epic:** Foundation
**Status:** Review
**Estimate:** M (2-3 days)
**Depends on:** 1.3 (Auth middleware), 1.4 (Engine core)
**Blocks:** 1.6 (Org settings API), all stories requiring engine correctness guarantee

## Context

NFR1 requires that every commission calculation rule is verified by a hand-calculated test before the webhook layer is built on top. The engine has 17 passing tests from Story 1.4. This story adds 33 more scenarios to reach exactly 50, covering percent_contract edge cases, ppw edge cases, plan version resolution, multi-rep/override logic, and status/approval behavior.

This is a test-only story — no production code changes. All amounts hand-calculated using Decimal.js banker's rounding (ROUND_HALF_EVEN, 2dp).

## User-facing change

None directly. Provides confidence gate for all upstream engine consumers.

## Acceptance Criteria

**AC1 — Exactly 50 passing engine tests**
Given the existing 17 tests in `commissionEngine.test.ts`
When this story is complete
Then there are exactly 50 passing integration tests in the engine test suite (33 new scenarios added)
And `pnpm test` reports 0 failures and 0 skipped tests

**AC2 — Hand-calculated amounts match to the cent**
Given the 33 new test scenarios
When each test runs against the real Postgres test database
Then every calculated amount matches the hand-calculated value to the cent using Decimal.js banker's rounding

**"Built Right" gates for this story:**
- Calculation correctness: all 50 amounts match hand-calculated values (direct test)
- Org Scoping: N/A (test-only story, uses isolated org per test)
- State Machine: covered by existing tests
- Idempotency: N/A

## Tasks/Subtasks

- [x] **Task 1: percent_contract edge cases (tests 18-27)**
  - [x] Test 18: contractValue = 0 → InvalidProjectConfigError, no event written
  - [x] Test 19: percent = 0 → earned event with amount = $0.00
  - [x] Test 20: split_percent = 50 → amount halved
  - [x] Test 21: split_percent = 33.33 → banker's rounding at final step
  - [x] Test 22: Very large contract ($999,999.99) × 5% → no overflow
  - [x] Test 23: Very small percent (0.01%) × $10,000 → $1.00
  - [x] Test 24: Two reps, split_percents sum to 100 → two events, amounts sum
  - [x] Test 25: Two reps, split_percents sum < 100 → each rep gets individual split
  - [x] Test 26: Clawback within grace period → clawed_back event = -(original × clawback_percent/100)
  - [x] Test 27: Clawback on grace period boundary (exactly N days) → fires (inclusive)

- [x] **Task 2: ppw edge cases (tests 28-35)**
  - [x] Test 28: system_size_kw = 0 → InvalidProjectConfigError
  - [x] Test 29: negative system_size_kw → InvalidProjectConfigError
  - [x] Test 30: 7.5kW × $0.15/W × 100% → $1125.00
  - [x] Test 31: 6.79kW × $0.1234/W → $837.89 (decimal precision)
  - [x] Test 32: split_percent = 75 on ppw → split applied after watts × rate
  - [x] Test 33: Two reps (closer 60%, setter 40%) on ppw → two events
  - [x] Test 34: 100kW × $0.50/W → $50,000.00 (no overflow)
  - [x] Test 35: ppw clawback on exact grace period boundary → fires

- [x] **Task 3: Plan version resolution (tests 36-40)**
  - [x] Test 36: Plan replaced occurs_at in new window → event linked to active plan
  - [x] Test 37: Plan assignment not yet effective at occurred_at → 0 events, warning logged
  - [x] Test 38: Plan assignment expired before occurred_at → 0 events, warning logged
  - [x] Test 39: Two roles, two trigger stages → two earned events
  - [x] Test 40: planOverrideId on project takes precedence over rep's default plan

- [x] **Task 4: Multi-rep and override (tests 41-45)**
  - [x] Test 41: Override with specific appliesToPlanIds → fires only for that plan
  - [x] Test 42: Override with appliesToPlanIds = null → fires for all plans
  - [x] Test 43: Two override rules (specific vs. general) → specific rule wins
  - [x] Test 44: Two specific override rules, same percent → exactly one override_earned event
  - [x] Test 45: teamMemberUserIds = [] → no override_earned fires

- [x] **Task 5: Status and approval (tests 46-50)**
  - [x] Test 46: require_event_approval = true → earned event status = pending
  - [x] Test 47: require_event_approval = false → earned event status = approved
  - [x] Test 48: Toggle from true→false, new transition → new event = approved; existing pending untouched
  - [x] Test 49: clawed_back event inherits approval behavior (pending when flag is true)
  - [x] Test 50: override_earned event inherits approval behavior (pending when flag is true)

- [x] **Task 6: Validation**
  - [x] `pnpm test` — all 60 tests pass (50 engine + 10 auth)
  - [x] `pnpm build` passes with no TypeScript errors
  - [x] `pnpm lint` clean

## Implementation notes

- All scenarios in `apps/api/src/services/commissionEngine.test.ts` inside existing `describe('CommissionEngine', ...)` block
- Each test uses `createOrg`, `createPlan`, `createPlanAssignment`, `createProject` fixtures; no mocks
- `SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000'` defined in describe scope for tests inserting events manually
- Schema has `systemSizeKw: numeric(precision: 8, scale: 2)` — input values must have at most 2 decimal places
- Grace period boundary: `ageDays <= grace_period_days` (inclusive). Fixed UTC dates used to avoid timing flakiness (e.g., earnDate = '2026-01-02T00:00:00Z', cancelDate = '2026-02-01T00:00:00Z' = exactly 30 days)
- Test 42 (null appliesToPlanIds): engine fires for all plans (null = all), documented in test description
- Test 44 (two specific rules, same percent): engine fires exactly one override_earned event; test checks count=1 since exact winner is implementation-defined (no ORDER BY)

## Files to create

None (test-only story).

## Files to modify

- `apps/api/src/services/commissionEngine.test.ts` (add 33 tests, lines ~863–end)

## Dev Agent Record

### Implementation Plan
- Added 33 new test scenarios (tests 18-50) inside the existing describe block
- Each test creates its own org/plan/project via fixture factories; `beforeEach` truncates DB for isolation
- Discovered schema constraint: `system_size_kw` numeric(8,2) limits input to 2dp — test 31 adjusted from `6.789` to `6.79` to match DB storage
- Used fixed UTC dates for all grace period boundary tests to eliminate timing flakiness
- Test 42 (null appliesToPlanIds): verified engine behavior is "fires for all plans" and documented accordingly
- Test 44 (two specific rules): checked count rather than exact winner since engine has no ORDER BY on tie-breaking

### Debug Log
- Test 31 initially failed: `expected '837.89' to be '837.76'` — root cause was schema `scale: 2` rounding `6.789` to `6.79` in DB, so actual watts = 6790 not 6789. Fixed by using `'6.79'` as input and `6790 × 0.1234 = 837.886 → 837.89` as expected value.

### Completion Notes
- All 50 engine tests pass; all 10 auth tests continue to pass (60 total)
- `pnpm build` and `pnpm lint` both clean
- AC1 (exactly 50 passing) and AC2 (hand-calculated amounts match to the cent) fully satisfied
- No production code changes — test-only story

### File List
- `apps/api/src/services/commissionEngine.test.ts` (updated: added tests 18-50)
