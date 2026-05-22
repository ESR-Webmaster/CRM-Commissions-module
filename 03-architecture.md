# Architecture: Sunscape Commissions

**Author:** Architect (via Kaushik)
**Date:** 2026-05-18
**Project:** sunscape-commissions
**Inputs:** 01-project-brief.md, 02-prd.md

## Tech stack

- **Frontend (standalone):** Vite + React + TypeScript
- **Frontend (library):** React + TypeScript, bundled with tsup (ESM + CJS + .d.ts)
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL with Drizzle ORM
- **Validation:** Zod, schemas shared via `/packages/shared`
- **Auth (v1):** Shared JWT signing key with Sunscape
- **Package registry:** GitHub Packages (private)
- **Containerization:** Docker + docker-compose for local dev

## Project layout

```
/sunscape-commissions
  /apps
    /web       # Vite + React standalone admin app
    /api       # Node + Express backend
  /packages
    /shared    # Shared TS types + Zod schemas
    /ui        # React component library, published as @sunscape/commissions-ui
  /db
    /migrations
    /seed
  docker-compose.yml
  README.md
```

pnpm workspace. `/apps/web` consumes `/packages/ui` the same way Sunscape will — this dogfoods the package contract.

## Data model (7 entities)

### commission_plans
Versioned by effective date; never edit in place.
- `id` (uuid, pk), `org_id` (uuid, indexed)
- `name` (text)
- `calculation_type` (enum: `percent_contract`, `ppw`, `tiered`, `hybrid`)
- `rules` (jsonb) — calculation parameters, tier breakpoints
- `earned_trigger_stage` (text)
- `payable_trigger` (jsonb) — `{ type: 'stage' | 'days_after_earned' | 'manual_approval', value }`
- `clawback_config` (jsonb, nullable) — `{ enabled: boolean, cancellation_stages: string[], clawback_percent: number, grace_period_days: number }`. Null or `{enabled: false}` disables clawbacks for this plan.
- `effective_from`, `effective_to` (timestamptz, end nullable)
- `is_active` (boolean)
- `created_at`, `updated_at`

### plan_assignments
- `id` (uuid, pk), `plan_id` (fk)
- `user_id` (uuid) — external Sunscape user
- `role` (enum: `closer`, `setter`, `manager`, `override_recipient`)
- `default_split_percent` (numeric(5,2), default 100.00)
- `effective_from`, `effective_to`

### project_commission_configs
- `id` (uuid, pk), `project_id` (uuid, unique), `org_id`
- `rep_assignments` (jsonb) — `[{ user_id, role, split_percent }]`
- `plan_override_id` (fk, nullable)
- `contract_value` (numeric(12,2))
- `system_size_kw` (numeric(8,2))
- `created_at`, `updated_at`

### commission_events (immutable ledger)
- `id` (uuid, pk), `org_id`, `project_id`, `user_id`, `plan_id`
- `event_type` (enum: `earned`, `adjusted`, `clawed_back`, `override_earned`, `adder`, `deduction`)
- `amount` (numeric(12,2)) — can be negative
- `triggering_stage_transition_id` (text, nullable, unique with event_type for idempotency)
- `status` (enum: `pending`, `approved`, `paid`, `disputed`)
- `notes` (text)
- `created_at`, `created_by`

Never updated except `status`. Corrections are new events with negative amounts.

### commission_adjustments
- `id` (uuid, pk), `project_id`, `user_id`
- `amount` (numeric(12,2))
- `reason` (enum: `redesign`, `change_order`, `bonus`, `penalty`, `manual`)
- `notes`, `created_by`
- `approved_by` (uuid, nullable), `approved_at` (timestamptz, nullable)
- `commission_event_id` (fk, nullable) — populated when approved

### override_rules
- `id` (uuid, pk), `org_id`
- `manager_user_id` (uuid)
- `team_member_user_ids` (uuid[])
- `override_percent` (numeric(5,2))
- `applies_to_plan_ids` (uuid[], nullable — null = all plans)
- `effective_from`, `effective_to`

### payout_statements
- `id` (uuid, pk), `org_id`, `user_id`
- `period_start`, `period_end`
- `total_earned`, `total_clawed_back`, `total_adjustments`, `net_payable` (numeric(12,2))
- `status` (enum: `draft`, `approved`, `paid`)
- `approved_by` (uuid, nullable)
- `event_ids` (uuid[]) — frozen at generation
- `created_at`

### audit_log (cross-cutting)
- `id`, `org_id`, `actor_user_id`, `entity_type`, `entity_id`, `action`, `before` (jsonb), `after` (jsonb), `created_at`

## Commission engine

Service at `/apps/api/src/services/commissionEngine.ts`.

**Trigger:** stage transition webhook from Sunscape.

**Flow:**
1. Receive `{ project_id, from_stage, to_stage, transition_id, delivery_id }`.
2. Idempotency check: has this `delivery_id` (or `transition_id`) already produced events? If yes, return existing event IDs with 200.
3. Resolve plan(s): query `project_commission_configs` for project; for each rep, find applicable plan (override or default assignment active at transition time).
4. For each plan where `earned_trigger_stage == to_stage`: calculate amount using `calculation_type` rules, apply rep's `split_percent`, write `earned` event with `triggering_stage_transition_id` set.
5. For each new `earned` event, query `override_rules` matching the rep's manager and plan; write `override_earned` events.
6. **Clawback handling (per-plan):** for each plan associated with the project, check `clawback_config`. If `enabled = true` AND `to_stage ∈ clawback_config.cancellation_stages`: find prior non-cancelled `earned` and `override_earned` events for this project under this plan. For each, check the grace period (event age vs `clawback_config.grace_period_days`); if within window, write negating `clawed_back` event for `clawback_config.clawback_percent` of the original. If a plan has clawback disabled, do nothing on cancellation.
7. Status defaults: `pending` if org requires approval, else `approved`.

**Idempotency:** unique constraint on `(triggering_stage_transition_id, user_id, event_type)`.

## API contract (v1)

**Integration endpoints (called by Sunscape):**
- `POST /api/v1/webhooks/stage-transition`
- `POST /api/v1/projects` (upsert config)
- `PATCH /api/v1/projects/:projectId`
- `POST /api/v1/users/sync`

**Admin/UI endpoints:**
- `GET|POST|PUT /api/v1/plans`
- `GET|POST|DELETE /api/v1/plan-assignments`
- `GET|POST /api/v1/override-rules`
- `GET /api/v1/events` (filters: user, project, date, status)
- `PATCH /api/v1/events/:id/status`
- `POST /api/v1/adjustments`
- `PATCH /api/v1/adjustments/:id/approve`
- `POST /api/v1/statements/generate`
- `GET /api/v1/statements/:id`
- `GET /api/v1/statements/:id/export` (CSV)

**Rep-facing endpoints:**
- `GET /api/v1/me/dashboard`
- `GET /api/v1/me/events`
- `GET /api/v1/me/statements`
- `POST /api/v1/events/:id/dispute`

**Outbound webhooks (Sunscape subscribes):**
- `commission.earned`
- `commission.clawed_back`
- `commission.statement_generated`

## `/packages/ui` component library

Published as `@sunscape/commissions-ui` to GitHub Packages.

**Build:** tsup, output ESM + CJS + .d.ts. React and react-dom as peer deps. `sideEffects: false`. Named exports only.

**Public API:**
```tsx
import {
  CommissionProvider,
  CommissionPanel,
  RepDashboard,
} from '@sunscape/commissions-ui';

<CommissionProvider
  apiBaseUrl="https://commissions.sunscape.app/api/v1"
  getAuthToken={async () => sunscapeAuth.getToken()}
  orgId={currentOrg.id}
  currentUserId={currentUser.id}
>
  <CommissionPanel projectId={project.id} />
  <RepDashboard userId={currentUser.id} />
</CommissionProvider>
```

**Theming:** CSS variables (`--sunscape-color-primary`, `--sunscape-radius`, `--sunscape-font-sans`). Sunscape overrides at root.

**Auth handshake:** `CommissionProvider` accepts async `getAuthToken`. v1 verifies with shared JWT signing key. JWKS path deferred to v2.

## Standalone admin app (`/apps/web`)

Views: Plans & Assignments (CRUD + approval queue), Rep Dashboard, Statements (list, generate, export).

Consumes `/packages/ui` as workspace dependency. If the package contract breaks, this app breaks first.

## Non-negotiables

- Strict TypeScript everywhere (no `any`, no `@ts-ignore`).
- Zod validation at every API boundary.
- Idempotency keys on all webhook handlers.
- Audit log on every status transition and config edit.
- No raw SQL outside migrations.
- Unit tests for commission engine (this is where bugs cost money).
- Integration tests for webhook handlers.
- Postman collection committed for Kochi team integration.

## v1 scope cut

Ship in 6-8 weeks:
- `percent_contract` and `ppw` plans only
- Single-rep assignments (splits in schema, not UI)
- Earned trigger only (payable = earned)
- Standalone admin: plans CRUD + approval queue + statements
- `@sunscape/commissions-ui` published with `CommissionProvider`, `CommissionPanel`, `RepDashboard`
- CSV export for statements

**v1.1:** splits UI, clawback UI.
**v1.2:** overrides UI, adjustments UI.
**v1.3:** tiered/hybrid plans, PDF statements, dispute workflow.

## Hand-off

Next: PO validates this against the PRD. SM agent shards into per-story files for the Dev/QA loop.
