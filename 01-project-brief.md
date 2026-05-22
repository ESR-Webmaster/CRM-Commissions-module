# Project Brief: Sunscape Commissions

**Author:** Analyst (via Kaushik)
**Date:** 2026-05-18
**Project:** sunscape-commissions
**Workflow:** greenfield-fullstack

## Problem statement

Solar installers and EPCs running on Sunscape have no native way to track sales rep commissions. Today they handle it in spreadsheets, which produces three failure modes: rep disputes consume sales-manager time, clawbacks on cancellation are routinely missed, and orgs can't run accurate sales-cost reporting. Compensation structures in solar vary widely (flat %, $/watt, tiered) and most orgs combine multiple structures across roles.

## Goal

Ship a commission tracking module that hooks into Sunscape's 9-stage project pipeline, calculates commissions automatically on stage transitions, maintains an auditable ledger, and produces payout statements. Reps should trust it enough to stop maintaining their own spreadsheets.

## Target users

- **Org admins** (CFO, ops manager): configure plans, approve payouts, generate statements.
- **Sales managers**: receive overrides on team performance, view team pipeline commission.
- **Sales reps** (closers, setters): see what they've earned, what's pending, what's projected on in-flight deals.

## Success criteria for v1

- A new org can configure their first plan, assign reps, and generate a statement in under 30 minutes.
- Commission calculations match a hand-calculated spreadsheet across 50 test scenarios.
- Engine is idempotent against duplicate stage-transition webhooks.
- Rep dashboard loads under 500ms with 1000 events.
- Zero raw SQL outside migrations; strict TypeScript; full Zod validation at API boundaries.

## Out of scope for v1

Splits (multiple reps on one deal), clawback UI, overrides UI, adjustments UI, PDF statements, dispute workflow, tiered/hybrid plan types, mobile app. Schema must support all of these; UI ships them later.

## Constraints

- Must run as an independent app (not embedded in Sunscape monorepo).
- Must publish a React component library to private npm so Sunscape can import the commission panel as a component.
- Must follow the standard Sunscape feature stack: Vite+React+TS, Node+Express+TS, Postgres+Drizzle, pnpm workspace.
- Kochi team handles Sunscape-side integration; this project owns everything up to and including the npm package they install.

## Open decisions for PM/Architect

- Auth model: shared JWT signing key vs JWKS endpoint (lean toward shared JWT for v1).
- Private registry host: GitHub Packages vs self-hosted Verdaccio.
- Whether commission data is visible to reps in real-time as deals progress or only after admin approval.
- Retroactive plan changes (recalculate prior periods on rate change) — keep schema ready, defer feature.

## Hand-off

Next: PM agent produces PRD with user stories and acceptance criteria. Architect produces architecture doc covering data model, commission engine, API contract, and `/packages/ui` library design.
