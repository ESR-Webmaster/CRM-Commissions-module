# PRD: Sunscape Commissions

**Author:** PM (via Kaushik)
**Date:** 2026-05-18
**Project:** sunscape-commissions
**Inputs:** 01-project-brief.md

## 1. Product overview

Commission tracking module for solar orgs running on Sunscape CRM. Calculates commissions automatically from project stage transitions, maintains an auditable ledger, and produces payout statements. Ships as a standalone web app for admins plus an embeddable React component library that Sunscape imports for in-context rep views.

## 2. Personas

### 2.1 Org admin (primary buyer)
CFO, ops manager, or owner. Configures plans, runs payroll, audits disputes. Cares about: accuracy, auditability, time saved vs spreadsheets. Tech comfort: moderate — uses QuickBooks and Salesforce, not a developer.

### 2.2 Sales manager
Runs a team of 3-20 reps. Earns overrides on team performance. Cares about: team pipeline visibility, knowing what they'll be paid this period. Tech comfort: moderate.

### 2.3 Sales rep (closer or setter)
Closes or sets solar deals. Cares about: trust in the number, knowing what's pending vs paid, projected earnings on deals in flight. Tech comfort: low to moderate — uses Sunscape on mobile and desktop. Will check this multiple times per week.

### 2.4 Sunscape platform (integration consumer)
Not a human, but a first-class user of the API and component library. Owned by Kochi team. Cares about: clear contract, predictable versioning, easy auth handshake.

## 3. User stories — v1 scope

### Epic A: Plan configuration

**A1. As an org admin, I can create a commission plan** with a name, calculation type (`percent_contract` or `ppw` in v1), the rules (percentage or $/W), the trigger stage from Sunscape's pipeline, effective dates, and clawback settings, so reps get paid the right amount on the right deals and money is recovered correctly on cancellations.

Acceptance:
- Plan creation form validates calculation_type and rules together (percent requires `percent` field; ppw requires `dollars_per_watt`).
- `effective_from` cannot be in the past on initial creation.
- `effective_to` must be after `effective_from` or null.
- Only one active plan with the same name per org at any given time.
- Clawback section of the form has its own `enabled` toggle (default off in v1). When enabled, admin specifies: the cancellation stage(s) that trigger clawback, whether to claw back 100% or a configurable percentage, and a grace period (in days from earned date) after which clawback no longer applies.
- Created plan immediately visible in plan list.

**A2. As an org admin, I can end-date an existing plan** and create a successor with new rates, so when comp structure changes I don't lose history.

Acceptance:
- Cannot directly edit `calculation_type` or `rules` on an existing plan with associated events.
- "End and replace" action sets `effective_to` on the current plan and opens the create form pre-populated with current values.
- Historical events remain linked to the original plan version forever.

**A3. As an org admin, I can assign a plan to a rep** with a role (`closer`, `setter`, `manager`, `override_recipient`) and effective dates, so the engine knows whose deals are subject to which plan.

Acceptance:
- A rep can have multiple active assignments simultaneously (different plans for different scopes), but only one per role per overlapping date range.
- Validation blocks overlapping assignments with the same role.
- Deactivating an assignment requires setting `effective_to`, not deletion.

### Epic B: Project setup and engine

**B1. As Sunscape, when a project is created or updated I can POST its commission config** (contract value, system size, rep assignments) to the commissions API, so the engine has what it needs when stage transitions fire.

Acceptance:
- Idempotent on `project_id`: repeated POSTs upsert.
- Validates that referenced `user_id` values exist (synced from Sunscape).
- Returns the stored config with computed projected commission per rep.

**B2. As Sunscape, when a project advances a stage I can POST a stage transition** to the commissions webhook, so commissions are calculated automatically.

Acceptance:
- Webhook accepts `{ project_id, from_stage, to_stage, transition_id, occurred_at }`.
- Idempotent on `transition_id` — duplicate POSTs never produce duplicate events.
- If no plan matches `to_stage` as its `earned_trigger_stage`, returns 200 with `{ events_created: 0 }`.
- If a plan matches, creates `earned` events for each applicable rep and returns the event IDs.
- Engine logs the input, the matched plan, the calculation, and the resulting events to the audit log.

**B3. As an org admin, I can preview projected commissions on an in-flight project** before it reaches the trigger stage, so I can sanity-check before deals close.

Acceptance:
- Endpoint accepts a `project_id` and returns the calculation that *would* run when the project hits the earned trigger stage.
- Preview never writes to the events ledger.

### Epic C: Rep visibility

**C1. As a rep, I can see my commission dashboard** showing MTD, QTD, YTD totals, pending vs approved breakdown, and a list of deals in flight with projected commission, so I trust the number and stop maintaining my own spreadsheet.

Acceptance:
- Dashboard loads in under 500ms for a rep with 1000 events.
- Totals match the ledger exactly (no caching staleness over 60 seconds).
- "Deals in flight" lists projects in `project_commission_configs` for the rep that haven't yet generated an `earned` event.

**C2. As a rep, I can see a per-project commission panel** embedded in the Sunscape project detail page, showing which plan applied, the calculation, my split, the event log, and any adjustments, so disputes get resolved by reading the panel instead of asking my manager.

Acceptance:
- Panel renders inside Sunscape's existing layout via `@sunscape/commissions-ui`.
- Shows the active plan name and rules in plain language ("3% of contract value").
- Lists every commission_event tied to this project with timestamp and status.
- If status is `pending`, panel shows an "Awaiting approval" indicator.

**C3. As a rep, I can see my most recent payout statement** with line items per deal, so I can reconcile against my paycheck.

Acceptance:
- Statement view shows period, total, and line items grouped by project.
- Each line item links to its underlying commission_event.
- CSV export available.

### Epic D: Admin workflow

**D1. As an org admin, I can review pending commission events** in an approval queue, so nothing gets paid out without my sign-off.

Acceptance:
- Queue lists all events with `status = pending` for my org.
- Each row shows rep, project, amount, calculated value, and a link to the source project.
- Bulk approve and bulk reject actions.
- Approval transitions status to `approved`; rejection requires a note and transitions to `disputed`.

**D2. As an org admin, I can generate a payout statement** for a date range and one or more reps, so I can hand it to payroll.

Acceptance:
- Generation locks the included events to the statement (`event_ids` array).
- Statement totals match the sum of included events.
- Once a statement is `approved` or `paid`, its events cannot be re-included in another statement.
- CSV export contains: rep, project, project address, event type, amount, event date, plan name, statement period.

**D3. As an org admin, I can configure whether new events require approval** before being eligible for a statement, so high-trust orgs can skip the queue.

Acceptance:
- Org-level setting `require_event_approval` (boolean, default `true`).
- When `false`, new `earned` events default to status `approved`.
- Setting change does not retroactively update existing events.

### Epic E: Integration deliverables

**E1. As the Kochi team, I can install `@sunscape/commissions-ui` and have a working component panel in Sunscape** within one sprint, so integration is straightforward.

Acceptance:
- Package published to GitHub Packages.
- README includes: install command, env vars needed, the 5-line provider setup, theming variable reference, full TypeScript types exported.
- The standalone `/apps/web` admin app consumes the package the same way Sunscape will — proving the contract works.

**E2. As the Kochi team, I can integrate against the commissions API using a Postman collection** committed in the repo, so I don't have to read source to learn the contract.

Acceptance:
- Collection covers every endpoint with example payloads and responses.
- Includes the webhook handler with example stage-transition payloads.
- README has an "Integrating from Sunscape" section walking through the auth handshake and the first three webhook integrations.

## 4. Acceptance criteria for the v1 release

- 50 hand-calculated commission scenarios match engine output exactly.
- Engine is idempotent against duplicate webhooks across a 1000-event soak test.
- Dashboard loads under 500ms with 1000 events for a single rep.
- Standalone admin app and `/packages/ui` both deploy from a single repo with a single `pnpm build`.
- A new org admin can sign in, configure a plan, assign a rep, simulate a stage transition, and see the resulting event in the rep dashboard in under 30 minutes following only the README.
- Zero `any` or `@ts-ignore` in the codebase.
- Audit log captures every plan create/update, every status transition, every config edit.

## 5. Explicit non-goals for v1

- Splits across multiple reps on one deal — schema supports `rep_assignments` as an array, but the UI only allows one rep per project.
- Tiered or hybrid plan types — `calculation_type` enum includes them, but only `percent_contract` and `ppw` are validated and supported in the UI.
- Overrides UI — `override_rules` table exists and the engine fires `override_earned` events if rules are inserted via SQL, but there's no admin UI to create them.
- Adjustments UI — `commission_adjustments` table exists, engine processes approved adjustments, but admin UI is deferred.
- Clawback UI (queue + management) — `commission_plans.clawback_config` exists and the engine reads it per-plan; admin can toggle clawback on/off and configure thresholds during plan creation. The engine writes `clawed_back` events automatically when the configured cancellation stage is reached AND clawback is enabled on the plan. What's deferred to v1.1: an admin view to list/review/manually trigger or reverse clawbacks.
- PDF statements — CSV only.
- Dispute resolution workflow — reps can flag a status as `disputed` via API, but no admin UI to resolve.
- Mobile-native app — the component library is responsive but no React Native build.
- Retroactive plan changes — schema supports re-running the engine against historical events, but no UI to trigger.
- Multi-currency — USD only.
- Real-time push of dashboard updates — polling on view load is fine for v1.

## 6. Edge cases the engine must handle correctly

These are the scenarios that have to be encoded in unit tests before any UI ships:

1. **Same project, multiple plans, same trigger stage.** Each rep on the project has their own plan; engine writes one event per rep, not one per plan.
2. **Plan version transition mid-pipeline.** Project was created under plan v1, advances to earned trigger after plan v2 became effective. Engine uses the plan that was active at `project_commission_configs.created_at`, not the latest version.
3. **Duplicate webhook delivery.** Same `transition_id` received twice. Second delivery returns 200 with the existing event IDs, writes nothing new.
4. **Cancellation after partial payment.** Project earned a commission, was paid out (statement closed), then cancels. Engine writes a `clawed_back` event. The clawback is its own event in a new statement period, not a retroactive edit of the closed statement.
5. **Rep removed from project mid-pipeline.** Project's `rep_assignments` updated to remove a rep before the trigger stage fires. The removed rep does not get an `earned` event.
6. **Rep added to project mid-pipeline.** A new rep is added after the trigger stage already fired. New rep does not retroactively earn — they only earn if the project advances through another trigger stage.
7. **Org `require_event_approval` toggled.** Setting changed from `true` to `false`. Pre-existing `pending` events stay pending; only new events default to `approved`.
8. **Adjustment approved after statement generated.** Adjustment creates a commission_event with date = approval date, which lands in the next open statement period, not the closed one.
9. **Zero or negative contract value.** Engine rejects the project config update at the API boundary; this never reaches calculation.
10. **System size or contract value updated after earned event already fired.** Engine does not recalculate. Admin must create a `commission_adjustment` for the delta. Audit log captures the original value and the change.

## 7. Open questions for Architect

- **Auth flow:** confirm shared JWT signing key for v1 with Kochi. Where is the secret stored and rotated?
- **Webhook delivery guarantees:** Sunscape will implement retry-with-backoff (tracked in CRMP2-2531, assigned to Gokul). Commissions engine treats each delivery as idempotent on `delivery_id`. No pull-based reconciliation endpoint needed for v1.
- **User identity:** is `user_id` from Sunscape a UUID or an integer? Spec assumes UUID; verify with Kochi.
- **Stage names:** are they strings, IDs, or both? `earned_trigger_stage` as `text` works for strings, but if Sunscape uses both internal IDs and display names, decide which goes in the plan config.
- **Multi-org data isolation:** is `org_id` enforced at the API layer (every query filters by it) or at the DB layer (Postgres RLS)? Recommend API layer for v1, RLS for v2.
- **Timezones:** statements run on org-local time. Where is org timezone stored? Add to org-sync if not present.

## 8. Hand-off

Next: Architect updates the architecture doc to address Section 7 open questions. PO validates brief + PRD + architecture for alignment. SM agent shards into stories per section.
