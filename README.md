# sunscape-commissions

Commission tracking and payout engine for the Sunscape solar platform. Calculates, tracks, and reconciles rep commissions across the project lifecycle.

## Project layout

```
/sunscape-commissions
  /apps
    /web          # Vite + React standalone admin app (localhost:5173)
    /api          # Node + Express backend (localhost:3001)
  /packages
    /shared       # Shared TypeScript types + Zod schemas
    /ui           # React component library → @sunscape/commissions-ui
  /db
    /migrations   # Drizzle-kit SQL migrations
    /seed         # Seed scripts
  docker-compose.yml
```

## Local dev

```bash
# Prerequisites: Docker, pnpm@9+
cp .env.example .env
docker compose up        # postgres + api + web, all wired up

# Or run services individually:
pnpm --filter api dev    # API on localhost:3001
pnpm --filter web dev    # Web on localhost:5173
```

## Package commands

```bash
pnpm install             # Install all workspace dependencies
pnpm build               # Build packages then apps in order
pnpm lint                # ESLint across all packages (0 warnings tolerance)
pnpm format              # Prettier write
pnpm format:check        # Prettier check (for CI)
```

## Package contract

`@sunscape/commissions-ui` is published to GitHub Packages and consumed by the main Sunscape web app:

```tsx
import { CommissionProvider, CommissionPanel, RepDashboard } from '@sunscape/commissions-ui';

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

## Database

Schema: `/apps/api/src/db/schema/` — one file per entity, re-exported from `index.ts`.  
Migrations: `/db/migrations/` — managed by drizzle-kit.

```bash
# Generate a new migration after schema changes
pnpm --filter api db:generate

# Apply pending migrations
DATABASE_URL=postgresql://commissions:commissions@localhost:5433/commissions \
  pnpm --filter api db:migrate

# Seed development data (idempotent — safe to run multiple times)
DATABASE_URL=postgresql://... pnpm --filter api db:seed

# Full reset + re-seed
DATABASE_URL=postgresql://... pnpm --filter api db:seed -- --reset
```

**Schema summary (9 tables):**

| Table | Purpose |
|---|---|
| `orgs` | Multi-tenant root; `settings.require_event_approval` controls payout flow |
| `commission_plans` | Versioned by `effective_from/to`; never edited in place |
| `plan_assignments` | Rep → plan links; exclusion constraint prevents overlapping date ranges |
| `project_commission_configs` | Per-project rep assignments and contract details |
| `commission_events` | **Immutable ledger** — only `status` can change after insert |
| `commission_adjustments` | Manual add/deduct entries; require approval to become events |
| `override_rules` | Manager override percentages for their team's earned commissions |
| `payout_statements` | Frozen snapshots of a rep's payable amount for a period |
| `audit_log` | Cross-cutting change log for every status transition and config edit |

**Note:** Docker's DB container is exposed on port **5433** to avoid conflicts with any local Postgres on 5432.

## Docs

- [Architecture](docs/architecture.md)
- [PRD](docs/prd.md)
- [Project Brief](docs/project-brief.md)
