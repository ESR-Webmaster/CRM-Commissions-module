# Requirements additions — sunscape-commissions

These entries fill gaps identified during requirements review. Drop into your requirements doc at the indicated insertion points. Numbering assumes you renumber sequentially from the current 51 FR / 14 NFR / 9 AR baseline.

---

## New Functional Requirements

### Admin Workflow domain (insert after FR45)

**FR46 — Audit log**

Every state-changing action on commission entities is recorded to an immutable audit log.

- The system records: plan create/update/end-date, plan assignment create/update/deactivate, project commission config upsert, commission event status transition (pending → approved, approved → paid, any → disputed), commission adjustment create/approve/reject, override rule create/update/deactivate, payout statement generate/approve/mark-paid, and org settings changes.
- Each audit row captures: actor user ID, timestamp, entity type, entity ID, action verb, before-state (jsonb, null on create), after-state (jsonb, null on delete), and `org_id` for tenant scoping.
- Audit rows are append-only. No API or admin function can delete or modify them.
- Audit log is queryable by entity (`/api/v1/audit?entity_type=...&entity_id=...`) and by actor (`/api/v1/audit?actor_user_id=...`), with date range filtering and pagination. v1 exposes API only; admin UI for browsing audit log is deferred to v1.2.
- Acceptance test: perform every covered action; verify an audit row exists with the correct before/after for each.

**FR47 — Org-level event approval setting**

The `require_event_approval` toggle on the org settings controls the default status of newly created commission events.

- When `true` (default for new orgs): new `earned`, `override_earned`, and `clawed_back` events created by the engine default to `status = 'pending'`.
- When `false`: same events default to `status = 'approved'`.
- Toggling the setting does not retroactively change existing events.
- Setting is exposed via `GET/PATCH /api/v1/orgs/me/settings`; only users with the `admin` role may change it.
- Every toggle writes an audit log row.
- Acceptance test: toggle from true to false on an org with existing `pending` events; verify existing events stay pending, new events default to approved.

### Rep Visibility domain (insert after FR33)

**FR34 — Projected commission preview**

The engine can compute what a commission event *would* be for a project without writing to the ledger, so reps see trustworthy projections on in-flight deals.

- Endpoint: `GET /api/v1/projects/:projectId/projected-commission?hypothetical_stage=<stage>`.
- Returns the per-rep, per-plan calculation that would run if the project advanced to the hypothetical stage. Includes the calculated amount, the plan name, the calculation explanation in plain English ("3% of $25,000 contract = $750"), and the rep's split percentage.
- Endpoint is read-only. It must never write to `commission_events` or `audit_log`.
- If no plan triggers on the hypothetical stage, returns an empty array (not an error).
- Rep dashboard "deals in flight" section consumes this endpoint per project.
- Acceptance test: call preview for a project that would earn $X; advance the project for real; verify the actual `earned` event amount equals $X to the cent.

### Project & Engine domain (insert after FR24)

**FR25 — Webhook idempotency keys**

The stage transition webhook handler treats `transition_id` (business event identifier from Sunscape) and `delivery_id` (per-attempt delivery identifier from Sunscape's retry machinery — see CRMP2-2531) as distinct idempotency keys.

- Both keys are stored on every `commission_event` created from the webhook.
- A repeated `delivery_id` (Sunscape retried the same delivery) is detected and returns 200 with the previously-created event IDs. No new events are written.
- A repeated `transition_id` with a different `delivery_id` (Sunscape considers the same business event a fresh delivery — should not happen with correctly-implemented retry, but defense in depth) is also detected via the existing unique constraint on `(triggering_stage_transition_id, user_id, event_type)`; returns 200 with existing event IDs.
- A new `transition_id` always produces new events (subject to plan-trigger matching).
- Acceptance test: submit the same `delivery_id` 10 times concurrently and serially — exactly one set of events exists in the DB; all 10 responses return the same event IDs.

### Integration Deliverables domain (insert after FR51)

**FR52 — Outbound webhooks to Sunscape**

The commissions app emits outbound webhooks that Sunscape can subscribe to, so Sunscape can react to commission lifecycle events (e.g., notify reps, update dashboards in the CRM, sync to accounting).

- Event types emitted in v1: `commission.earned`, `commission.clawed_back`, `commission.statement_generated`.
- Each webhook payload includes: a unique `delivery_id`, the event type, the `org_id`, the canonical resource (event object, statement object), and `occurred_at`.
- Subscriptions are configured per-org via `POST /api/v1/webhook-subscriptions`. Each subscription specifies: target URL, event types (array), and a signing secret used for HMAC-SHA256 payload signing in the `X-Sunscape-Signature` header.
- Failed deliveries are retried with exponential backoff (1m, 5m, 15m, 1h, 6h, 24h; max 6 attempts). After exhaustion, the delivery lands in a dead-letter queue accessible via `GET /api/v1/webhook-deliveries?status=failed`. Admin can manually replay via `POST /api/v1/webhook-deliveries/:id/retry`.
- Webhook delivery history is queryable, retained 90 days minimum.
- Acceptance test: subscribe to `commission.earned`; trigger a stage transition that creates an earned event; verify the subscriber receives a signed POST within 60 seconds; verify the signature validates with the configured secret.

---

## New Architecture Requirement

### Operational concerns (insert as AR10)

**AR10 — Operational readiness**

The commissions app is production-ready on day one in the operational dimensions, not just functional.

- **Structured logging.** All log output is JSON via pino. Every log line includes a request ID (generated at the API edge, propagated via async local storage), `org_id` when in tenant context, and `user_id` when in authenticated context. No console.log anywhere in production code.
- **Error tracking.** Sentry (or equivalent) integrated in the api process. Uncaught exceptions, unhandled promise rejections, and explicit error captures all reach the error tracker. Source maps uploaded on each deploy. PII (rep names, contract values) is scrubbed from error context before transmission.
- **Health checks.** Three endpoints:
  - `GET /health` — process is alive (returns 200 always if the process is running).
  - `GET /health/ready` — process is ready to serve traffic; checks DB connectivity, current migration version matches expected, and any external dependency (Redis if used for webhooks) is reachable. Returns 503 with details if any check fails.
  - `GET /health/version` — returns build SHA, version string, and migration version. No auth required.
- **Graceful shutdown.** On SIGTERM, the process stops accepting new connections, finishes in-flight requests with a 30s timeout, closes the DB pool, and exits cleanly. Webhook delivery workers finish current job before exiting.
- **Database connection pooling.** Configured pool size, idle timeout, and query timeout. Sensible defaults documented in `.env.example`.
- **Rate limiting.** Per-org rate limits on the webhook receiver endpoint (default 100 req/sec/org). Configurable via env. Returns 429 with `Retry-After` header on breach.
- **Metrics.** Prometheus-compatible `/metrics` endpoint exposing: request count by route + status, request duration histogram, DB query duration, webhook delivery success/failure counts, engine processing duration. v1 ships the endpoint; dashboarding is left to whoever operates the deploy.

Acceptance: ops checklist runs before v1 release-candidate cut. All seven bullets above verified by inspection or test.

---

## Renumbering notes

Inserting these additions affects sequential numbering downstream. Two options:

**Option A — Insert and renumber.** Cleaner long-term, but every existing reference (story files, brief, architecture doc) needs a sweep. Mechanical but tedious.

**Option B — Append at the end.** New FRs become FR52–FR56, regardless of their domain. Domain grouping in the requirements doc is by table/section, not by number. No renumbering of existing FRs.

For v1, recommend Option B — domain grouping in the document handles readability; numbers are just stable identifiers. Renumber only if numbers ever conflict.

---

## Updated counts after additions

| Domain | Before | After |
|---|---|---|
| Plan Config | 14 | 14 |
| Project & Engine | 10 | 11 (+FR25 idempotency) |
| Rep Visibility | 9 | 10 (+FR34 preview) |
| Admin Workflow | 12 | 14 (+FR46 audit log, +FR47 approval setting) |
| Integration Deliverables | 6 | 7 (+FR52 outbound webhooks) |
| **Total FR** | **51** | **56** |
| **Total NFR** | 14 | 14 (unchanged) |
| **Total AR** | 9 | 10 (+AR10 operational) |

---

## Cross-references for the SM agent

When sharding into stories, these new entries map to story slots:

- FR25 (webhook idempotency) → folds into Story 1.5 (webhook handler) acceptance criteria.
- FR34 (preview) → already specified in Story 1.4 engine acceptance criteria (`previewProjectedCommission` function); needs its own thin API story (suggest Story 1.7).
- FR46 (audit log) → engine already writes audit rows per Story 1.4; needs a query API story (suggest Story 1.12) and gets surfaced through v1.2 UI.
- FR47 (org settings) → small CRUD story on org settings (suggest Story 1.6, before plans CRUD).
- FR52 (outbound webhooks) → substantial story; suggest splitting into FR52a (subscription CRUD + signing) and FR52b (delivery worker + retry + dead-letter). Two stories.
- AR10 (operational) → cross-cutting; spread across foundation stories. Logger setup lands in Story 1.1, health checks in Story 1.3, Sentry/metrics in a dedicated Story 1.14 before release.
