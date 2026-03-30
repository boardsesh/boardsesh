# Migration Plan: Next.js → TanStack Start

## Overview

Migrate Boardsesh from Next.js 15 to TanStack Start with Selective SSR. This eliminates SSR overhead on interactive routes (70% of pages) while keeping server rendering for shareable/SEO pages. Consolidates all REST APIs into GraphQL on the Railway backend and migrates auth from next-auth to Better Auth.

**Branch strategy**: All work happens on the `rewrite` branch. Each milestone is a feature branch merged into `rewrite`. Branch deploys at `rewrite.preview.boardsesh.com` for continuous testing. Merge to `main` only when all milestones are complete and verified.

```
main (production)
└── rewrite (integration branch)
    ├── rewrite/m0-backend-graphql
    ├── rewrite/m1-backend-auth
    ├── rewrite/m2-spa-scaffold
    ├── rewrite/m3-core-routes
    ├── rewrite/m4-remaining-routes
    ├── rewrite/m5-infrastructure
    └── rewrite/m6-cleanup
```

---

## Milestone 0: Backend GraphQL Expansion

**Goal**: Backend becomes self-sufficient — every REST endpoint in `packages/web/app/api/` has a GraphQL equivalent.
**Branch**: `rewrite/m0-backend-graphql`
**Risk**: Zero — existing Next.js app is untouched.

### Tasks

#### 0.1 Board data resolvers
Add to `packages/backend/src/graphql/resolvers/board/`:
- [ ] `boardGrades(boardName: String!)` — grade list (replaces `/api/v1/[board]/grades`)
- [ ] `boardAngles(boardName: String!, layoutId: Int!)` — angle list (replaces `/api/v1/angles/[board]/[layout]`)
- [ ] `climbStats(boardName: String!, climbUuid: String!)` — difficulty per angle (replaces `/api/v1/[board]/climb-stats/[uuid]`)
- [ ] `climbBetaLinks(boardName: String!, climbUuid: String!)` — YouTube/Instagram links (replaces `/api/v1/[board]/beta/[uuid]`)
- [ ] `holdHeatmap(input: HeatmapInput!)` — hold usage data (replaces `/api/v1/.../heatmap`)
- [ ] `resolveSlug(boardName: String!, type: SlugType!, slug: String!, ...)` — board slug resolution (replaces 3 slug routes)
- [ ] `climbDetail(boardName: String!, layoutId: Int!, sizeId: Int!, setIds: String!, angle: Int!, climbUuid: String!)` — single climb (replaces `/api/v1/.../[climb_uuid]`)
- [ ] `setters(input: SetterInput!)` — setter list (replaces `/api/v1/.../setters`)

#### 0.2 Aurora proxy resolvers
Add to `packages/backend/src/graphql/resolvers/aurora/`:
- [ ] `auroraLogin(boardName: String!, username: String!, password: String!)` — proxy login
- [ ] `auroraSaveAscent(boardName: String!, input: SaveAscentInput!)` — proxy save ascent
- [ ] `auroraSaveClimb(boardName: String!, input: SaveClimbInput!)` — proxy save climb
- [ ] `auroraGetLogbook(boardName: String!, userId: Int!)` — proxy logbook
- [ ] `auroraUserSync(boardName: String!, input: UserSyncInput!)` — sync user data

#### 0.3 User management resolvers
Extend `packages/backend/src/graphql/resolvers/users/`:
- [ ] `updateProfile(input: UpdateProfileInput!)` — mutation (replaces `/api/internal/profile` PATCH)
- [ ] `publicProfile(userId: String!)` — query (replaces `/api/internal/profile/[userId]` GET)
- [ ] `setPassword(currentPassword: String!, newPassword: String!)` — mutation
- [ ] `auroraCredentials` — query (replaces `/api/internal/aurora-credentials` GET)
- [ ] `saveAuroraCredentials(input: AuroraCredentialsInput!)` — mutation
- [ ] `unsyncedAuroraCredentials` — query
- [ ] `userBoardMappings` — query (replaces `/api/internal/user-board-mapping` GET)
- [ ] `saveUserBoardMapping(input: UserBoardMappingInput!)` — mutation
- [ ] `auroraImport(input: AuroraImportInput!)` — mutation

#### 0.4 Admin resolvers
Add to `packages/backend/src/graphql/resolvers/admin/`:
- [ ] `holdClassifications(boardName: String!)` — query
- [ ] `saveHoldClassification(input: HoldClassificationInput!)` — mutation
- [ ] `esp32Controllers` — query
- [ ] `registerController(input: ControllerInput!)` / `deleteController(id: String!)` — mutations
- [ ] `climbRedirect(climbUuid: String!)` — resolve climb UUID to URL

#### 0.5 Cron jobs
- [ ] Move user-sync-cron to backend in-process timer or Railway cron
- [ ] Move shared-sync/[board] to backend Railway cron
- [ ] Remove `crons` section from `vercel.json` (after cutover)

#### 0.6 HTTP cache headers
- [ ] Add response cache headers on GraphQL HTTP handler based on operation:
  - `searchClimbs` (default): `public, max-age=2592000`
  - `searchClimbs` (filtered): `public, max-age=3600`
  - `discoverPlaylists`: `public, max-age=300`
  - `boardGrades`, `boardAngles`: `public, max-age=86400`
  - User-specific queries: `private, no-cache`

#### 0.7 GraphQL schema updates
- [ ] Add all new types/inputs to `packages/shared-schema/src/schema.ts`
- [ ] Register resolvers in `packages/backend/src/graphql/resolvers/index.ts`
- [ ] Run `bun run typecheck` — all packages pass

### Verification
- [ ] Every new resolver works via GraphQL Playground
- [ ] Existing Next.js app still works (no changes to `packages/web/`)
- [ ] Backend tests pass (`bun run --filter=boardsesh-backend test`)

---

## Milestone 1: Backend Auth (Better Auth)

**Goal**: Backend handles all authentication. Dual-token validation supports both old (next-auth JWE) and new (Better Auth session) clients.
**Branch**: `rewrite/m1-backend-auth`
**Depends on**: M0 (resolvers available for auth-protected operations)

### Tasks

#### 1.1 Install and configure Better Auth
- [ ] Add `better-auth` to `packages/backend/`
- [ ] Create `packages/backend/src/auth/index.ts` with:
  - Drizzle adapter mapped to existing tables (`users`, `accounts`, `sessions`, `verificationTokens`)
  - Email/password with custom bcrypt verify (reads from `user_credentials` table)
  - Google, Apple, Facebook social providers
  - Session cookie configuration (domain: `.boardsesh.com`)

#### 1.2 Auth API endpoints
- [ ] Mount Better Auth handler on backend HTTP server (`/auth/*`)
- [ ] Registration endpoint with rate limiting (port logic from `packages/web/app/api/auth/register/route.ts`)
- [ ] Email verification endpoint (port from `packages/web/app/api/auth/verify-email/route.ts`)
- [ ] Resend verification endpoint
- [ ] Provider config endpoint (port from `packages/web/app/api/auth/providers-config/route.ts`)

#### 1.3 Dual-token validation
- [ ] Update `packages/backend/src/middleware/auth.ts`:
  - Try Better Auth session token validation first (DB lookup)
  - Fall back to existing `validateNextAuthToken()` (JWE decryption)
  - Log which method was used for monitoring

#### 1.4 WebSocket auth update
- [ ] WebSocket connection accepts Better Auth session token in `connectionParams`
- [ ] Falls back to next-auth JWE token (existing flow)
- [ ] Remove need for separate `/api/internal/ws-auth` endpoint (client reads session token directly)

#### 1.5 User profile creation hook
- [ ] On new user creation (OAuth or registration), auto-create `user_profiles` row (port from next-auth `createUser` event in `packages/web/app/lib/auth/auth-options.ts`)

#### 1.6 Set-password endpoint
- [ ] Port `/api/internal/set-password` logic as GraphQL mutation or Better Auth plugin

### Verification
- [ ] New user registration via Better Auth → user, credentials, profile created
- [ ] Google/Apple/Facebook OAuth login → matches existing account by provider+providerAccountId
- [ ] Email/password login → bcrypt verify against existing `user_credentials` hash
- [ ] WebSocket connects with both token types
- [ ] Old Next.js app still works with existing next-auth (dual validation)

---

## Milestone 2: SPA Scaffold

**Goal**: TanStack Start app boots, authenticates, and renders a shell with all context providers.
**Branch**: `rewrite/m2-spa-scaffold`
**Depends on**: M1 (auth endpoints available)

### Tasks

#### 2.1 Project setup
- [ ] Create `packages/spa/` with TanStack Start (Vite + TanStack Router)
- [ ] Configure `vite.config.ts`:
  - `@tanstack/start/plugin`
  - TypeScript paths: `@/*` → `./app/*`, `@/c/*` → `./app/components/*`, `@/lib/*` → `./app/lib/*`
  - SVG support
- [ ] Configure `tsconfig.json` matching current strict settings
- [ ] Add to root `package.json` workspaces

#### 2.2 Core dependencies
- [ ] MUI (Material UI) — theme config from `packages/web/app/theme/theme-config.ts`
- [ ] TanStack Query — `QueryClientProvider` with current config
- [ ] Better Auth React client — `@better-auth/react`
- [ ] GraphQL client — `graphql-request` for HTTP, `graphql-ws` for subscriptions
- [ ] Sentry — `@sentry/react` + `@sentry/vite-plugin`

#### 2.3 Root layout
Port from `packages/web/app/layout.tsx`:
- [ ] Theme provider (MUI)
- [ ] Query client provider
- [ ] Auth provider (Better Auth)
- [ ] Snackbar provider
- [ ] Navigation loading provider
- [ ] Global styles, fonts

#### 2.4 Board layout
Port from `packages/web/app/b/[board_slug]/[angle]/layout.tsx`:
- [ ] Board provider context
- [ ] Queue bridge provider
- [ ] Persistent session provider
- [ ] Bluetooth provider
- [ ] WebSocket connection provider
- [ ] Party provider

#### 2.5 Auth pages
- [ ] Login page (`/auth/login`) — `ssr: false`
- [ ] Register page (if separate)
- [ ] Verify email page — `ssr: false`
- [ ] Auth error page — `ssr: false`
- [ ] Wire up Better Auth client (login, register, OAuth redirects)

#### 2.6 Environment variables
- [ ] `VITE_WS_URL` (replaces `NEXT_PUBLIC_WS_URL`)
- [ ] `VITE_ENABLE_ONBOARDING_TOUR` (replaces `NEXT_PUBLIC_ENABLE_ONBOARDING_TOUR`)
- [ ] Server-side env vars for SSR routes (if needed): `DATABASE_URL`, auth secrets

### Verification
- [ ] `bun run dev` starts Vite dev server
- [ ] App renders root layout with theme
- [ ] Login with email/password works
- [ ] OAuth login redirects work
- [ ] Auth state persists across page reloads
- [ ] `bun run typecheck` passes

---

## Milestone 3: Core Routes

**Goal**: The main user flow works end-to-end — browse, queue, play, log ascent.
**Branch**: `rewrite/m3-core-routes`
**Depends on**: M2 (scaffold with auth and providers)

### Tasks

#### 3.1 Play view (`/b/$slug/$angle/play/$climbUuid`)
- [ ] Route file: `ssr: true` (OG tags for sharing)
- [ ] Server function for `generateMeta` (climb name, grade, setter, quality)
- [ ] Loader: fetch climb data via GraphQL
- [ ] Port `PlayViewClient` component tree
- [ ] Port swipe board carousel, climb title, ascent status
- [ ] Port queue control bar (bottom bar with next/prev)
- [ ] Port Bluetooth send-to-board button

#### 3.2 Climb list (`/b/$slug/$angle/list`)
- [ ] Route file: `ssr: 'data-only'` (server prefetch, client render)
- [ ] Loader: GraphQL `searchClimbs` with TanStack Query prefetch
- [ ] Port `BoardPageClimbsList` component
- [ ] Port search/filter drawer
- [ ] Port climb card components

#### 3.3 Home page (`/`)
- [ ] Route file: `ssr: 'data-only'`
- [ ] Loader: prefetch session feed + user boards
- [ ] Port `HomePageContent` (tabs, feed, board selection)
- [ ] Port activity feed components
- [ ] Port unified search

#### 3.4 Climb detail (`/b/$slug/$angle/view/$climbUuid`)
- [ ] Route file: `ssr: true` (OG tags)
- [ ] Server function for meta (climb details, grade, ascent count)
- [ ] Port `ClimbDetailPageServer` / `ClimbDetailContent`
- [ ] Port beta links, community grade, comments

#### 3.5 Queue and Bluetooth integration
- [ ] Verify queue add/remove/navigate works
- [ ] Verify Bluetooth LED control sends frames on climb change
- [ ] Verify IndexedDB queue persistence across reloads

### Verification
- [ ] Browse climb list → add to queue → navigate to play → see board render
- [ ] Bluetooth connects and LEDs light up
- [ ] Log ascent (tick) → appears in logbook
- [ ] Share play view URL → OG preview shows climb name/grade
- [ ] Share climb detail URL → OG preview shows climb info
- [ ] Queue persists after page reload

---

## Milestone 4: Remaining Routes

**Goal**: Full route parity with existing Next.js app.
**Branch**: `rewrite/m4-remaining-routes`
**Depends on**: M3 (core flow works)

### Tasks

#### 4.1 Playlists
- [ ] `/playlists` — `ssr: 'data-only'` — library with discover
- [ ] `/playlists/$uuid` — `ssr: false` — playlist detail

#### 4.2 Social / profiles
- [ ] `/crusher/$userId` — `ssr: true` — profile with OG tags
- [ ] `/setter/$username` — `ssr: true` — setter profile with OG tags
- [ ] `/session/$sessionId` — `ssr: true` — session detail with OG tags (participant names, stats)

#### 4.3 Party mode
- [ ] Verify session creation, joining, real-time queue sync
- [ ] `/join/$sessionId` — `ssr: false` — validate + redirect

#### 4.4 Notifications
- [ ] `/notifications` — `ssr: false`
- [ ] WebSocket subscription for real-time notifications

#### 4.5 User pages
- [ ] `/settings` — `ssr: false`
- [ ] `/auth/login`, `/auth/error`, `/auth/verify-request` — `ssr: false` (ported in M2)

#### 4.6 Content pages
- [ ] `/about` — `ssr: false`
- [ ] `/help` — `ssr: false`
- [ ] `/docs` — `ssr: false` (lazy-load Swagger UI + GraphQL schema viewer)

#### 4.7 Board-specific routes
- [ ] `/b/$slug/$angle/create` — `ssr: false`
- [ ] `/b/$slug/$angle/liked` — `ssr: false`
- [ ] `/b/$slug/$angle/import` — `ssr: false`

#### 4.8 Admin
- [ ] `/admin` — `ssr: false`

#### 4.9 Redirects
- [ ] `/my-library` → `/playlists`
- [ ] Old `/[board]/[layout]/[size]/[set]/[angle]/playlist/$uuid` → `/playlists/$uuid`
- [ ] Old `/[board]/[layout]/[size]/[set]/[angle]/*` → `/b/$slug/$angle/*` (via slug lookup)

### Verification
- [ ] Every URL from the old app resolves in the new app
- [ ] Party mode: create → invite → sync → leave
- [ ] Notifications: real-time badge + list
- [ ] Profile OG tags work when shared
- [ ] Session detail OG tags work when shared
- [ ] Playlist CRUD works
- [ ] Settings saves correctly
- [ ] Admin panel accessible to admin users

---

## Milestone 5: Infrastructure

**Goal**: Production-ready deployment pipeline for the new app.
**Branch**: `rewrite/m5-infrastructure`
**Depends on**: M4 (all routes ported)

### Tasks

#### 5.1 Docker
- [ ] Update `Dockerfile.web` for TanStack Start Nitro output:
  ```dockerfile
  # Build stage
  RUN bun run build  # outputs .output/server/index.mjs

  # Run stage
  CMD ["node", ".output/server/index.mjs"]
  ```
- [ ] Update `docker-compose.yml` if needed for local dev

#### 5.2 CI/CD
- [ ] Update `.github/workflows/test.yml` — build + lint + typecheck for `packages/spa/`
- [ ] Update `.github/workflows/e2e-tests.yml` — start TanStack Start server instead of Next.js
- [ ] Update `.github/workflows/branch-deploy.yml` — build new Dockerfile, deploy to preview

#### 5.3 Hosting
- [ ] TanStack Start Node server deployed to Railway (or keep Docker on current infra)
- [ ] Configure Traefik routing:
  - `/auth/*` → backend (Better Auth)
  - `/graphql` → backend (GraphQL)
  - `/*` → SPA (TanStack Start)
- [ ] Security headers in Traefik: X-Frame-Options, HSTS, X-Content-Type-Options, Referrer-Policy

#### 5.4 Monitoring
- [ ] Sentry: `@sentry/react` + `@sentry/vite-plugin` source map upload
- [ ] Sentry tunnel endpoint on backend (replaces `/monitoring` Next.js tunnel)
- [ ] Analytics: PostHog or Plausible (replaces `@vercel/analytics`)
- [ ] Web Vitals: `web-vitals` package (replaces `@vercel/speed-insights`)

#### 5.5 OG image generation
- [ ] Backend endpoint or Cloudflare Worker for `/og/climb` (replaces `@vercel/og`)
- [ ] Uses Satori for SVG → PNG rendering

### Verification
- [ ] Branch deploy works at `rewrite.preview.boardsesh.com`
- [ ] E2E Playwright tests pass on branch deploy
- [ ] Sentry captures errors with source maps
- [ ] Analytics events fire
- [ ] OG images generate correctly for shared links

---

## Milestone 6: Cleanup and Cutover

**Goal**: Remove old code, merge to main.
**Branch**: `rewrite/m6-cleanup`
**Depends on**: M5 (infra verified)

### Tasks

#### 6.1 Remove old app
- [ ] Delete `packages/web/` (entire Next.js app)
- [ ] Rename `packages/spa/` → `packages/web/`
- [ ] Update all workspace references in root `package.json`, `tsconfig.json`

#### 6.2 Remove dual-token auth
- [ ] Remove `validateNextAuthToken()` from `packages/backend/src/middleware/auth.ts`
- [ ] Remove `jose`, `@panva/hkdf` dependencies from backend
- [ ] Remove `NEXTAUTH_SECRET` env var requirement from backend

#### 6.3 Remove Next.js dependencies
- [ ] Remove `next`, `next-auth`, `@auth/drizzle-adapter` from package.json
- [ ] Remove `@vercel/analytics`, `@vercel/speed-insights`, `@vercel/og`
- [ ] Remove `@sentry/nextjs`
- [ ] Remove `next.config.ts`, `middleware.ts`

#### 6.4 Code cleanup
- [ ] Remove all `"use client"` directives
- [ ] Remove all `typeof window === 'undefined'` SSR guards
- [ ] Remove `suppressHydrationWarning` usage
- [ ] Remove side-effect-only components (e.g., `LastUsedBoardTracker` that renders null)
- [ ] Remove `AdapterAccount` type import from `packages/db/src/schema/auth/users.ts`

#### 6.5 Documentation
- [ ] Update `CLAUDE.md` — new commands, architecture, no Next.js references
- [ ] Update `docs/websocket-implementation.md` — new auth flow
- [ ] Update `vercel.json` or remove if no longer on Vercel
- [ ] Archive this migration plan as completed

#### 6.6 Final verification
- [ ] Full E2E test suite passes
- [ ] Manual QA on branch deploy:
  - Auth: login, register, OAuth, logout
  - Core: browse, queue, play, Bluetooth, log ascent
  - Party: create, invite, sync, leave
  - Social: profiles, notifications, comments, follows
  - Playlists: create, edit, discover, delete
  - Admin: role management, controllers
  - OG: share links render previews
  - Offline: queue persists, session restores
- [ ] Performance: Lighthouse mobile ≥ current scores
- [ ] No console errors or Sentry issues on branch deploy

#### 6.7 Merge to main
- [ ] PR from `rewrite` → `main`
- [ ] Team review
- [ ] Merge and deploy
- [ ] Monitor Sentry and analytics for 48 hours
- [ ] Delete `rewrite` branch

---

## Timeline Estimate

| Milestone | Scope | Notes |
|-----------|-------|-------|
| M0: Backend GraphQL | ~20 resolvers, schema updates | Can start immediately, zero risk |
| M1: Backend Auth | Better Auth setup, dual validation | Depends on M0, medium complexity |
| M2: SPA Scaffold | Vite + Router + providers | Depends on M1, foundational |
| M3: Core Routes | 4 routes + queue + Bluetooth | Depends on M2, highest effort |
| M4: Remaining Routes | ~15 routes | Depends on M3, parallelizable |
| M5: Infrastructure | Docker, CI/CD, monitoring | Depends on M4, ops-focused |
| M6: Cleanup | Delete old code, merge | Depends on M5, low risk |

M0 and M1 can overlap with M2 development since they modify different packages.

---

## Key Files Reference

| Area | Current Location | After Migration |
|------|-----------------|-----------------|
| Root layout | `packages/web/app/layout.tsx` | `packages/spa/app/routes/__root.tsx` |
| Board layout | `packages/web/app/b/[board_slug]/[angle]/layout.tsx` | `packages/spa/app/routes/b/$slug/$angle.tsx` |
| Play view | `packages/web/app/b/[board_slug]/[angle]/play/[climb_uuid]/page.tsx` | `packages/spa/app/routes/b/$slug/$angle/play.$climbUuid.tsx` |
| Climb list | `packages/web/app/b/[board_slug]/[angle]/list/page.tsx` | `packages/spa/app/routes/b/$slug/$angle/list.tsx` |
| Home | `packages/web/app/page.tsx` | `packages/spa/app/routes/index.tsx` |
| Auth options | `packages/web/app/lib/auth/auth-options.ts` | `packages/backend/src/auth/index.ts` |
| Backend auth middleware | `packages/backend/src/middleware/auth.ts` | Same file, updated for Better Auth |
| GraphQL schema | `packages/shared-schema/src/schema.ts` | Same file, extended |
| All REST API routes | `packages/web/app/api/**/*.ts` | Deleted (replaced by GraphQL resolvers) |
