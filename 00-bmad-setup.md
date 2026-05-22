# BMAD setup for sunscape-commissions

## Install

```bash
mkdir sunscape-commissions
cd sunscape-commissions
npx bmad-method install
```

When the installer asks for workflow type, pick **greenfield-fullstack**.

## Docs already prepared

Drop these into `docs/` at the project root after installation:

- `docs/project-brief.md` ← use `01-project-brief.md`
- `docs/architecture.md` ← use `03-architecture.md`

The PRD (`docs/prd.md`) is the missing piece. Two ways to produce it:

**Option A (recommended):** Run the BMAD PM agent against the project brief. It will ask clarifying questions about user stories, acceptance criteria, and prioritization. This is the part where the agent actually earns its keep — it'll surface edge cases (what happens when a rep transfers mid-deal, how disputes flow, etc.) that I'd otherwise miss.

**Option B:** Ask me in this thread to draft a PRD from the brief and architecture, then iterate. Faster but less rigorous.

## Workflow once docs are in place

1. **PO agent** validates brief + PRD + architecture are aligned. Catches contradictions.
2. **SM agent** shards the docs into individual story files in `docs/stories/`. Each story gets full context embedded — the Dev agent never has to read the parent docs.
3. **Dev agent** picks up a story, implements it, runs tests.
4. **QA agent** validates against acceptance criteria, kicks back if anything missing.
5. Repeat per story until v1 is done.

## Suggested first stories (SM agent will refine these)

1. Repo scaffold: pnpm workspace, /apps/web, /apps/api, /packages/shared, /packages/ui, docker-compose, tsconfigs.
2. DB schema: Drizzle definitions for all 7 entities + audit_log, initial migration, seed script.
3. Auth middleware: shared JWT verification, org-scoping middleware, user context.
4. Commission engine service + unit tests (this is the heart, build it before any API/UI).
5. Stage-transition webhook handler with idempotency.
6. Plans CRUD API + Zod schemas in /packages/shared.
7. Plan assignments CRUD API.
8. Events query API + status update endpoint.
9. `/packages/ui` scaffold with tsup, CommissionProvider, theming tokens.
10. RepDashboard component + corresponding API endpoint.
11. CommissionPanel component + corresponding API endpoint.
12. Standalone /apps/web consuming /packages/ui (Plans page, Approval queue page).
13. Statement generation + CSV export.
14. Postman collection + integration README for Kochi team.
15. Publish `@sunscape/commissions-ui@0.1.0` to GitHub Packages.

## Things to set up in parallel with planning

- Create GitHub repo `sunscape-commissions` under your org.
- Enable GitHub Packages on the org if not already.
- Decide on the npm scope: `@sunscape` (matches org name) vs `@kaushik` (personal).
- Coordinate with Jiji on the Kochi side: who handles the integration sprint when v1 ships? When does Sunscape need a sandbox URL of the commissions API to integrate against?

## Notes on BMAD v6 specifics

- v6 added Skills Architecture — the Dev agent can call domain-specific skills. Worth checking if there's a skill for Drizzle/Express scaffolding to save time on story #1.
- Use `npx bmad-method@latest` not `@next` unless you want the bleeding edge.
- The Orchestrator agent can coordinate the planning sequence so you don't have to manually invoke each agent. Worth using for the first run.
