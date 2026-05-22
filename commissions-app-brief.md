# Sunscape Commissions — Claude Code Brief

## What we're building

A standalone commission tracking application that integrates with Sunscape CRM via API/webhooks. **This is a separate app, not part of the Sunscape monorepo.** The Kochi team will handle integration on the Sunscape side.

## Architecture

- **Frontend:** Vite + React + TypeScript
- **Backend:** Node.js (Express) + TypeScript
- **Database:** PostgreSQL (use Drizzle ORM)
- **Auth:** JWT, with a stub for SSO/SAML later
- **Integration surface:** REST API (versioned `/api/v1/...`) + outbound webhooks for events
- **Deployment target:** Containerized, deploy-ready (Dockerfile + docker-compose for local dev)

Treat this as a multi-tenant SaaS from day one — every entity is scoped by `org_id`.

## Project structure

```
/commissions
  /apps
    /web       (Vite + React standalone admin app)
    /api       (Node + Express backend)
  /packages
    /shared    (shared TS types, Zod validation schemas)
    /ui        (React component library, published to private npm)
  /db
    /migrations
    /seed
  docker-compose.yml
  README.md
```

Use a pnpm workspace. The `/apps/web` standalone app consumes `/packages/ui` the same way Sunscape will — this guarantees the package actually works as a consumable library and isn't accidentally coupled to the standalone app.

## Data model (7 core entities)

### 1. `commission_plans`
- `id` (uuid, pk)
- `org_id` (uuid, indexed)
- `name` (text)
- `calculation_type` (enum: `percent_contract`, `ppw`, `tiered`, `hybrid`)
- `rules` (jsonb) — calculation parameters, tier breakpoints, etc.
- `earned_trigger_stage` (text) — Sunscape pipeline stage name
- `payable_trigger` (jsonb) — `{ type: 'stage' | 'days_after_earned' | 'manual_approval', value: ... }`
- `effective_from` (timestamptz)
- `effective_to` (timestamptz, nullable)
- `is_active` (boolean)
- `created_at`, `updated_at`

Plans are versioned by effective date. Never edit in place — create a new version and end-date the old one.

### 2. `plan_assignments`
- `id` (uuid, pk)
- `plan_id` (fk → commission_plans)
- `user_id` (uuid) — references external Sunscape user
- `role` (enum: `closer`, `setter`, `manager`, `override_recipient`)
- `default_split_percent` (numeric(5,2), default 100.00)
- `effective_from`, `effective_to`

### 3. `project_commission_configs`
- `id` (uuid, pk)
- `project_id` (uuid, indexed, unique) — references external Sunscape project
- `org_id` (uuid)
- `rep_assignments` (jsonb) — array of `{ user_id, role, split_percent }`
- `plan_override_id` (fk → commission_plans, nullable)
- `contract_value` (numeric(12,2))
- `system_size_kw` (numeric(8,2))
- `created_at`, `updated_at`

This is set when a deal is created in Sunscape and synced via webhook.

### 4. `commission_events` (immutable ledger)
- `id` (uuid, pk)
- `org_id` (uuid, indexed)
- `project_id` (uuid, indexed)
- `user_id` (uuid, indexed)
- `plan_id` (fk → commission_plans)
- `event_type` (enum: `earned`, `adjusted`, `clawed_back`, `override_earned`, `adder`, `deduction`)
- `amount` (numeric(12,2)) — can be negative
- `triggering_stage_transition_id` (text, nullable) — ID from Sunscape webhook
- `status` (enum: `pending`, `approved`, `paid`, `disputed`)
- `notes` (text)
- `created_at` (timestamptz)
- `created_by` (uuid)

**Never updated except for `status`.** Corrections = new events with negative amounts.

### 5. `commission_adjustments`
- `id` (uuid, pk)
- `project_id` (uuid)
- `user_id` (uuid)
- `amount` (numeric(12,2))
- `reason` (enum: `redesign`, `change_order`, `bonus`, `penalty`, `manual`)
- `notes` (text)
- `created_by` (uuid)
- `approved_by` (uuid, nullable)
- `approved_at` (timestamptz, nullable)
- `commission_event_id` (fk → commission_events, nullable) — populated when approved

### 6. `override_rules`
- `id` (uuid, pk)
- `org_id` (uuid)
- `manager_user_id` (uuid)
- `team_member_user_ids` (uuid[])
- `override_percent` (numeric(5,2))
- `applies_to_plan_ids` (uuid[], nullable — null means all plans)
- `effective_from`, `effective_to`

### 7. `payout_statements`
- `id` (uuid, pk)
- `org_id` (uuid)
- `user_id` (uuid)
- `period_start`, `period_end`
- `total_earned`, `total_clawed_back`, `total_adjustments`, `net_payable` (numeric(12,2))
- `status` (enum: `draft`, `approved`, `paid`)
- `approved_by` (uuid, nullable)
- `event_ids` (uuid[]) — frozen at generation time
- `created_at`

## Commission engine logic

Build as a service (`/api/src/services/commissionEngine.ts`):

1. **Trigger:** receives a stage transition event (from Sunscape webhook).
2. **Resolve plan:** look up `project_commission_configs` for the project, find applicable plan (override or default assignment).
3. **Check trigger match:** is the new stage == plan's `earned_trigger_stage`?
4. **Calculate amount(s):** apply `calculation_type` rules to `contract_value` / `system_size_kw`, split across `rep_assignments`.
5. **Write events:** one `earned` event per rep. Status = `pending` if org requires approval, else `approved`.
6. **Apply overrides:** for each `earned` event, check `override_rules` matching the rep's manager, write `override_earned` events.
7. **Handle clawbacks:** if new stage is a cancellation stage, find prior `earned`/`override_earned` events for the project and write negating `clawed_back` events.

Make this idempotent — same `triggering_stage_transition_id` should never produce duplicate events.

## API surface (v1)

### Integration endpoints (called by Sunscape)
- `POST /api/v1/webhooks/stage-transition` — receives stage change events
- `POST /api/v1/projects` — create/upsert project commission config
- `PATCH /api/v1/projects/:projectId` — update config (contract value, splits, etc.)
- `POST /api/v1/users/sync` — bulk sync users from Sunscape

### Admin/UI endpoints
- `GET|POST|PUT /api/v1/plans`
- `GET|POST|DELETE /api/v1/plan-assignments`
- `GET|POST /api/v1/override-rules`
- `GET /api/v1/events` — with filters (user, project, date range, status)
- `PATCH /api/v1/events/:id/status` — approve/dispute
- `POST /api/v1/adjustments` — create adjustment (pending until approved)
- `PATCH /api/v1/adjustments/:id/approve`
- `POST /api/v1/statements/generate` — period-based generation
- `GET /api/v1/statements/:id`
- `GET /api/v1/statements/:id/export` — CSV

### Rep-facing endpoints
- `GET /api/v1/me/dashboard` — MTD/QTD/YTD totals, pending vs approved, projected from in-flight deals
- `GET /api/v1/me/events`
- `GET /api/v1/me/statements`
- `POST /api/v1/events/:id/dispute`

### Outbound webhooks (Sunscape subscribes)
- `commission.earned`
- `commission.clawed_back`
- `commission.statement_generated`

## Frontend (Vite + React)

The frontend has two distinct delivery modes:

### Mode 1: Standalone web app (`/apps/web`)
Full admin app for org admins and reps to use directly. Three primary views:

1. **Admin: Plans & Assignments** — CRUD for plans, assignments, override rules. Approval queue for pending events and adjustments.
2. **Rep Dashboard** — MTD/QTD/YTD cards, pending vs approved breakdown, in-flight deals with projected commission, recent events table.
3. **Statements** — list, view, export.

### Mode 2: Embeddable React component library (`/packages/ui`)
Publish a separate package that Sunscape imports as an npm dependency. This is how the commission panel gets into the CRM's project detail page.

**Package structure:**
```
/packages/ui
  /src
    /components
      CommissionPanel.tsx       (main project-level panel)
      RepDashboard.tsx          (reusable dashboard widget)
      StatementViewer.tsx
    /hooks
      useCommissionApi.ts       (API client hook)
      useAuth.ts                (token handling)
    /styles
      tokens.css                (CSS variables, themeable)
    index.ts                    (public exports)
  package.json
  tsup.config.ts                (bundler — outputs ESM + CJS + .d.ts)
```

**Build config:**
- Bundle with **tsup** (not Vite) — Vite is for apps, tsup is for libraries. Outputs ESM, CJS, and TypeScript declarations.
- React and react-dom as **peer dependencies**, not bundled. Sunscape provides them.
- Tailwind as `devDependency` only — emit plain CSS using CSS variables so Sunscape doesn't need to configure Tailwind to use the components.
- Tree-shakeable: every component is a named export, no default exports, `sideEffects: false` in package.json.
- Publish to a **private npm registry** (GitHub Packages or Verdaccio self-hosted). Don't publish to public npm.

**Public API of the component package:**
```tsx
import { CommissionProvider, CommissionPanel, RepDashboard } from '@sunscape/commissions-ui';

// At the app root in Sunscape:
<CommissionProvider
  apiBaseUrl="https://commissions.sunscape.app/api/v1"
  getAuthToken={async () => sunscapeAuth.getToken()}
  orgId={currentOrg.id}
  currentUserId={currentUser.id}
  theme={{ primary: '#...', radius: '8px' }}  // optional override
>
  {/* Sunscape app */}
</CommissionProvider>

// In the project detail page:
<CommissionPanel projectId={project.id} />

// In a rep's home screen:
<RepDashboard userId={currentUser.id} />
```

**Theming:** Components consume CSS variables (`--commissions-color-primary`, `--commissions-radius`, etc.). Sunscape can override these to match its design system without forking the package.

**Auth handshake:** `CommissionProvider` accepts a `getAuthToken` async function. Sunscape's existing auth provides the token; the commissions API validates it (use shared JWT signing key, or the commissions API can verify Sunscape-issued JWTs via JWKS endpoint — decide during integration with Kochi team).

**Versioning:** Strict semver. Breaking changes = major version. The Kochi team pins a version in their package.json; you control rollout.

## v1 scope (ship in 6-8 weeks)

Cut to land fast:
- Plans: `percent_contract` and `ppw` only (skip tiered/hybrid)
- Single-rep assignments (skip splits — schema supports it, UI doesn't expose it yet)
- Earned trigger on stage transition (payable_trigger = same as earned for v1)
- Commission event ledger
- Standalone admin app: plans CRUD + approval queue + statements
- `/packages/ui` published with: `CommissionProvider`, `CommissionPanel`, `RepDashboard`
- Statement generation with CSV export
- Private npm registry set up and `@sunscape/commissions-ui@0.1.0` published

**Stubbed but not built in v1:** splits UI, clawbacks UI (engine supports it), overrides UI (rules exist), adjustments UI, PDF statements, dispute workflow, tiered/hybrid plans, StatementViewer component.

## Non-negotiables

- **Strict TypeScript everywhere** — no `any`, no `@ts-ignore`.
- **Zod validation** at every API boundary, schemas in `/packages/shared`.
- **Idempotency keys** on all webhook handlers.
- **Audit log table** that records who changed what and when (every status transition, every config edit).
- **No raw SQL outside migrations** — use Drizzle.
- **Tests:** unit tests for the commission engine (this is where bugs cost money), integration tests for webhook handlers.
- **Postman/Insomnia collection** committed to repo so the Kochi team can integrate without guessing.

## Deliverables for first run

1. Scaffold the pnpm monorepo with the structure above.
2. Drizzle schema + initial migration for all 7 entities.
3. Seed data: 1 org, 2 plans (one percent, one ppw), 3 users (admin, 2 reps), 5 sample projects across stages.
4. Webhook handler for `stage-transition` with the engine logic.
5. `/packages/ui` scaffolded with tsup, peer deps, CSS variables. Ship `CommissionProvider` + a working `RepDashboard` component.
6. `/apps/web` consumes `/packages/ui` as a workspace dependency, proving the package contract works end-to-end.
7. README with: local dev setup, how to publish the UI package to a private registry, and an "Integrating into Sunscape" section the Kochi team will use.
8. Postman collection for all v1 endpoints.

Start with the schema and engine. Get the ledger right before building any UI. Build `/packages/ui` and `/apps/web` in parallel — the standalone app exists primarily to dogfood the component package.
