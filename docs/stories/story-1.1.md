# Story 1.1: Repo scaffold

**Epic:** Foundation
**Status:** Review
**Estimate:** S (1-2 days)
**Depends on:** None
**Blocks:** Every other story

## Context

This is the first story in `sunscape-commissions`, a greenfield standalone app. The repo follows the standard Sunscape feature stack — see `docs/architecture.md` section "Project layout" for the canonical structure. Two future consumers of this repo:

1. The Kochi team (Jiji, Gokul, et al.) will integrate against the API and consume `@sunscape/commissions-ui` from GitHub Packages.
2. The standalone `/apps/web` admin app dogfoods the package — if the package contract breaks, the admin app breaks first.

This story sets up the scaffolding only. No business logic, no DB schema yet (that's Story 1.2).

## User-facing change

None. Internal infrastructure only.

## Acceptance criteria

- pnpm workspace at repo root with packages declared.
- `/apps/web` is a Vite + React 18 + TypeScript app. `pnpm --filter web dev` runs the dev server at localhost:5173.
- `/apps/api` is a Node + Express + TypeScript app using tsx for dev. `pnpm --filter api dev` runs the server at localhost:3001 with `/health` returning `{ status: "ok" }`.
- `/packages/shared` exists and exports a placeholder `version` constant. Built with tsup. Type-safe import works from both `/apps/web` and `/apps/api`.
- `/packages/ui` exists, builds with tsup, exports a placeholder `<HelloCommissions />` component. React and react-dom are peer dependencies. `package.json` has `"sideEffects": false`. Outputs ESM + CJS + .d.ts.
- `/apps/web` imports `<HelloCommissions />` from `@sunscape/commissions-ui` via workspace dependency and renders it on the home route.
- Root `tsconfig.base.json` defines strict TypeScript settings; per-package tsconfigs extend it. `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noImplicitAny": true`.
- ESLint + Prettier configured at root. `pnpm lint` and `pnpm format` work across all packages.
- `docker-compose.yml` at root with: postgres:16, the api service, the web service. `docker compose up` brings everything online and the web app talks to the api.
- `.env.example` at root with all required env vars documented.
- README at root has: project intent (one paragraph), the layout, local dev commands, the package contract overview, link to docs/.
- No `any`, no `@ts-ignore` anywhere.

## Implementation notes

- Use `pnpm@9` or later. Lock version in `packageManager` field of root package.json.
- Vite 5+, React 18+, TypeScript 5.4+.
- For `/packages/ui` tsup config: `format: ['esm', 'cjs']`, `dts: true`, `external: ['react', 'react-dom']`, `clean: true`.
- For the web → ui workspace import, use `"@sunscape/commissions-ui": "workspace:*"` in `/apps/web/package.json`.
- Don't set up the private registry publish yet — that's Story 1.10. Just get the workspace consumption working.
- Don't write any tests for this story; testing infra is in Story 1.3.
- Database connection is NOT part of this story — that's 1.2. The api should run standalone with just `/health`.

## Files to create

- `/package.json` (workspace root)
- `/pnpm-workspace.yaml`
- `/tsconfig.base.json`
- `/.eslintrc.cjs`
- `/.prettierrc`
- `/docker-compose.yml`
- `/.env.example`
- `/README.md`
- `/.gitignore`
- `/apps/web/package.json`, `/apps/web/tsconfig.json`, `/apps/web/vite.config.ts`, `/apps/web/index.html`, `/apps/web/src/main.tsx`, `/apps/web/src/App.tsx`
- `/apps/api/package.json`, `/apps/api/tsconfig.json`, `/apps/api/src/index.ts`, `/apps/api/src/app.ts`
- `/packages/shared/package.json`, `/packages/shared/tsconfig.json`, `/packages/shared/tsup.config.ts`, `/packages/shared/src/index.ts`
- `/packages/ui/package.json`, `/packages/ui/tsconfig.json`, `/packages/ui/tsup.config.ts`, `/packages/ui/src/index.ts`, `/packages/ui/src/HelloCommissions.tsx`

## QA gate

QA agent verifies:
1. Fresh clone + `pnpm install` + `docker compose up` works end-to-end with no manual steps.
2. Web app loads, renders `<HelloCommissions />`, no console errors.
3. API `/health` returns 200.
4. Changing a string in `/packages/ui/src/HelloCommissions.tsx`, rebuilding the package, restarting web → change appears.
5. `pnpm lint` passes with zero warnings.
6. `pnpm build` builds every package without errors.
7. No `any`, `@ts-ignore`, or `@ts-expect-error` outside of generated files.

## Dev Agent Record

### Implementation Plan
- Greenfield monorepo scaffold using pnpm workspaces
- Root: package.json, pnpm-workspace.yaml, tsconfig.base.json, ESLint, Prettier, docker-compose, .gitignore, .env.example, README
- /packages/shared: version constant, tsup build
- /packages/ui: HelloCommissions component, tsup ESM+CJS+dts, react/react-dom as peer deps
- /apps/api: Express + TypeScript via tsx, /health endpoint
- /apps/web: Vite + React 18, imports HelloCommissions from workspace

### Debug Log
- Fixed TS2742 on `app` export in `apps/api/src/app.ts`: added explicit `Express` type annotation to avoid non-portable type reference
- Fixed web `tsconfig.json` rootDir conflict with vite.config.ts: split into tsconfig.json (src only) + tsconfig.node.json (vite.config.ts) using project references
- Fixed "types" condition ordering in exports map for both packages (must come before import/require per bundler spec)

### Completion Notes
Full monorepo scaffold implemented and validated:
- All 4 workspaces build cleanly: `pnpm build` succeeds end-to-end
- `pnpm lint` exits 0 with --max-warnings 0
- No `any`, `@ts-ignore`, or `@ts-expect-error` in any source file
- API dev server starts on localhost:3001, /health returns `{ status: "ok" }`
- Web builds and imports `HelloCommissions` from `@sunscape/commissions-ui` workspace dependency
- `packages/ui` outputs ESM + CJS + .d.ts with react/react-dom as peer deps and `sideEffects: false`
- `tsconfig.base.json` has strict, noUncheckedIndexedAccess, noImplicitAny; all per-package tsconfigs extend it
- docker-compose.yml wires postgres:16, api, web services

### File List
- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `.eslintrc.cjs`
- `.prettierrc`
- `.gitignore`
- `.env.example`
- `README.md`
- `docker-compose.yml`
- `apps/api/Dockerfile`
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/tsconfig.build.json`
- `apps/api/src/app.ts`
- `apps/api/src/index.ts`
- `apps/web/Dockerfile`
- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/web/tsconfig.node.json`
- `apps/web/vite.config.ts`
- `apps/web/index.html`
- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`
- `packages/shared/package.json`
- `packages/shared/tsconfig.json`
- `packages/shared/tsup.config.ts`
- `packages/shared/src/index.ts`
- `packages/ui/package.json`
- `packages/ui/tsconfig.json`
- `packages/ui/tsup.config.ts`
- `packages/ui/src/index.ts`
- `packages/ui/src/HelloCommissions.tsx`

## Handoff to next story

Story 1.2 (DB schema) picks up from here. It assumes the api is running and adds Drizzle, the migration system, and all 7 entity definitions.
