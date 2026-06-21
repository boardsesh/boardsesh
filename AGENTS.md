# AGENTS.md

This file adds repo-specific guidance for agents creating or updating public pages in Boardsesh.

## SEO for New Pages

### Decide if the page should rank

- Classify every new route as one of: indexable marketing page, indexable public entity page, utility/auth/session page, or duplicate/alternate experience page.
- Marketing pages should be indexable and canonical to themselves.
- Public entity pages should only be indexable if the first server-rendered HTML contains meaningful public content.
- Utility, auth, settings, session, and ephemeral pages should default to `noindex, follow`.
- Duplicate or alternate UX routes should usually be `noindex, follow` and canonical to the main page.

### Metadata checklist for indexable pages

- Set a unique `title`, `description`, and canonical URL with `alternates.canonical`.
- Add matching Open Graph and Twitter metadata.
- Add an explicit `robots` directive whenever a page should not be indexed.
- Avoid generic titles and descriptions such as `Profile | Boardsesh`, `Playlist | Boardsesh`, or `Page | Boardsesh`.
- Prefer title formats like `Topic or Entity | Boardsesh`.
- Match search intent naturally. Descriptive phrases like `Kilter Board app alternative` are fine when the page clearly presents Boardsesh as a compatible alternative, not the official app.

### First-render content requirements

- If a page is meant to rank, the first server-rendered HTML must include useful text content.
- Ship at least one clear `h1`, one or more descriptive paragraphs, and crawlable internal links near the top of the page.
- Do not rely on client-only fetching, spinners, drawers, or click-to-open UI for the page's main copy.
- If meaningful public content cannot be rendered on the server, improve SSR or mark the page `noindex`.

### Canonical and noindex defaults

- Canonicalize filtered, sorted, paginated, or query-param variants back to the clean base page unless the variant is intentionally indexable.
- Canonicalize duplicate experiences to the primary route.
- Keep private or auth-gated content out of the index.
- Do not let tool pages, session pages, or alternate player/viewer routes compete with the main public route.

### Internal linking rules

- Important public pages must be reachable through crawlable `Link href` or `<a href>` links.
- Do not rely on `router.push`, clickable `div`s, or button-only navigation for key SEO surfaces.
- Add at least 2 to 3 relevant internal links to or from each new indexable page.
- Use descriptive anchor text that explains the destination.

### Structured data defaults

- Consider JSON-LD for indexable pages when the page type supports it.
- Use `Organization` and `WebSite` for the homepage, `BreadcrumbList` for page hierarchies, and `ProfilePage` for public profile-like pages when appropriate.
- Only add structured data that matches visible page content.
- Validate rich-result markup before shipping when relevant.

### Sitemap rules

- Review sitemap inclusion whenever you add a new public page type.
- Add only public, canonical, indexable URLs to the sitemap.
- Keep utility, duplicate, filtered, and auth-only routes out of the sitemap.
- Use real content timestamps where possible instead of a generic "now" value.

### Pre-ship checklist

- Is this page supposed to rank?
- Does it have unique metadata?
- Is the first server-rendered HTML useful without client hydration?
- Is the canonical correct?
- Should it be `noindex` instead?
- Can crawlers reach it through normal links?
- Should it be added to the sitemap?
- If trademarked board names are used, is the wording descriptive and non-affiliative?

---

## Copied Project Guidance from CLAUDE.md

The following repo guidance was copied from CLAUDE.md so Codex reads it from AGENTS.md.

## Project Overview

Boardsesh is a monorepo containing a Next.js 16 application for controlling standardized interactive climbing training boards (Kilter, Tension). It adds missing functionality to boards using Aurora Climbing's software, including queue management and real-time collaborative control.

## Project Rules

- We are slowly moving away from running rest-apis and backend operations in the next.js service, instead packages/backend should implement all backends, ideally using graphql
- Work autonomously end-to-end. Backend + frontend + deploy + QA. Never stop at "the API is ready but the UI isn't updated."
- Use subagents (always Opus) for all grunt work. Pair every implementation subagent with a QA/reviewer subagent.
- Work high-level: divide work, subagents execute, you orchestrate and fix issues.
- No AI-generated images ever. Real photos or diagrams only.
- No buzzwords. Concrete numbers and simple language.
- No unnecessary check-ins. Default to action. Full autonomy except no data deletion without asking.
- Do not leave completed code or documentation changes local-only. Unless the user explicitly opts out, publish validated changes in a pull request and share the PR with the user.

## GitHub Issue Fix Workflow

When fixing a GitHub issue, follow this sequence:

1. **Work in a fresh git worktree branched off the latest `main`.** Fetch `origin/main` first; do not branch from whatever HEAD happens to be.
2. **Plan the fix before implementing.** Produce an explicit plan of the change before writing code.
3. **After implementing, make sure the pre-commit hook passes.** If it fails, fix the underlying issue rather than bypassing it (no `--no-verify`).
4. **Write the QA plan to a notes file before starting the dev server.** Always create `.boardsesh/qa-notes.md` (the default path the orchestrator auto-detects) with the concrete QA plan: the specific pages/flows to exercise, what correct behavior looks like, and the edge cases worth poking at. The orchestrator surfaces the file's contents inside the running app via `/api/internal/dev-metadata`, so the user can read the plan in the browser while testing. If you have a reason to put the notes somewhere else, start the server with `vp run dev -- --qa-notes-file <path>` (alias: `--qa-plan-file`). Never start the dev server for a GitHub-issue fix without a QA notes file — running it bare drops the in-app QA context the user expects.
5. **Start the dev server with `vp run dev`** so the user can test the fix in the browser. The orchestrator picks up `.boardsesh/qa-notes.md` automatically; confirm in the startup output that it logged `[dev] QA notes: <path>`.
6. **Tell the user the dev server URL in a single message** as soon as the server is up. Report whatever URL the server actually prints (typically `http://localhost:3000`) and mention that the QA plan is loaded into the app from `.boardsesh/qa-notes.md`. Don't paste the full QA plan into chat — it's already in the file you wrote and surfaced in-app.
7. **Always open a PR** for the GitHub issue once the fix is implemented and validated.

This applies to any request framed as "fix issue #N", "this GH issue", "the bug from <issue link>", or similar. It does not apply to ad-hoc edits or feature work the user requested directly without referencing an issue. If the user explicitly opts out of any step for a given task, respect that for the current task only — the default still holds next time.

## Database Hosting (Railway)

We host PostgreSQL on Railway. **Treat Railway as a portable stepping stone, not a permanent marriage.** Railway is currently better gravity than Neon (simpler, less magical, closer to "Docker + Postgres") but it is still a platform. The whole point of leaving Neon was to escape platform gravity — don't accidentally re-create it.

When making infrastructure or backend changes:

- **Keep Postgres vanilla.** Use standard PostgreSQL features. Don't reach for Railway-only addons, Railway-managed extensions, or Railway-flavoured wrappers. Anything you write should run unchanged on a `docker run postgres:17` instance.
- **No Railway-specific service assumptions in app code.** No `RAILWAY_*` env vars threaded into business logic. No code paths that branch on the deploy target. The app should not be able to tell Railway from a self-hosted box from a developer laptop.
- **Use standard Docker builds.** No Railway-only build steps, no `railway.toml`-encoded behaviour the app depends on. The Dockerfile should build and run anywhere.
- **Keep migrations in-repo.** All schema changes live in `packages/db/drizzle/` and run via `bunx drizzle-kit generate` + `vp run db:migrate`. Never use Railway's UI / dashboard to mutate schema.
- **`pg_dump` / `pg_restore` is the exit plan.** A vanilla logical dump must be sufficient to lift-and-shift Postgres to another host. If you ever need a Railway-specific tool to extract data, you've taken a wrong turn — back out.
- **Keep object storage, video, and analytics deliberately portable.** Same rule for any other service we add: prefer S3-compatible APIs, OpenTelemetry-shaped exporters, standard connection strings. Avoid platform-specific managed primitives where a portable equivalent exists.

The migration runbook (`docs/neon-migration.md`) documents how to move off Neon. Future migrations off Railway should be similarly straightforward — that's the test for whether we're staying portable.

## Documentation

Before working on a specific part of the codebase, check the `docs/` directory for relevant documentation:

- `docs/websocket-implementation.md` - WebSocket party session architecture, connection flow, failure states and recovery mechanisms
- `docs/ai-design-guidelines.md` - Comprehensive UI design guidelines, patterns, and tokens for redesigning components

**Important:**

- Read the relevant documentation first to understand the architecture and design decisions before making changes
- When making significant changes to documented systems, update the corresponding documentation to keep it in sync

## Monorepo Structure

```
/packages/
  /web/           # Next.js web application
  /backend/       # WebSocket backend for party mode (graphql-ws)
  /shared-schema/ # Shared GraphQL schema and TypeScript types
  /db/            # Shared database schema, client, and migrations (drizzle)
```

## Commands

### Development Setup

The development database uses a **pre-built Docker image** (`ghcr.io/boardsesh/boardsesh-dev-db`) that already contains all Kilter, Tension, and MoonBoard board data, a test user, and social seed data with migrations applied. This means `vp run db:up` is fast — it just pulls the image, starts containers, and runs any newer migrations.

```bash
# Install Vite+ CLI (one-time, manages Node.js, linting, formatting, testing)
curl -fsSL https://vite.plus | bash

# Environment files are in packages/web/:
# .env.local contains generic config (tracked in git)
# .env.development.local contains secrets (NOT tracked in git)

# Note: VERCEL_URL is automatically set by Vercel for deployments
# For local development, the app defaults to http://localhost:3000

# Install all dependencies (from root)
vp install

# Install Git hooks (runs vp staged on commit)
vp config

# Start everything (databases, backend, web)
# First run pulls the pre-built image (~1GB) with all board data included.
# Subsequent runs start in seconds.
# Test user: test@boardsesh.com / test
vp run dev
```

#### Pre-built database image

The `boardsesh-dev-db` image is published to GHCR and contains PostgreSQL 17 + PostGIS with all Kilter/Tension/MoonBoard board data pre-loaded, a test user (`test@boardsesh.com` / `test`), social seed data (fake users, follows, ticks, comments, notifications), and all drizzle migrations applied. It is rebuilt automatically when files in `packages/db/docker/`, `packages/db/scripts/`, `packages/db/src/schema/`, `packages/db/drizzle/`, or `packages/db/package.json` change on main.

- **Pull directly**: `docker pull ghcr.io/boardsesh/boardsesh-dev-db:latest`
- **Reset your local database**: `docker compose down -v && vp run db:up`
- **Build locally** (e.g. to test Dockerfile changes): `docker compose up -d --build postgres`

### Common Commands (from root)

This project uses [Vite+](https://viteplus.dev) (`vp`) as its unified toolchain for testing, linting, formatting, type checking, and task running. Most commands use `vp` directly or `vp run` for tasks defined in the root `vite.config.ts`.

- `vp check` - Run format, lint, and type checks (this is the canonical validation command and what runs in pre-commit)
- `vp test` - Run all tests
- `vp test run` - Run tests once without watch mode
- `vp lint` - Lint all packages
- `vp fmt` - Format all files with Oxfmt
- `vp run dev` - Start development databases, backend, and web server
- `vp run dev:mobile` - Start the React Native (Expo) Metro dev server
- `vp run mobile:android-shots` - Boot an Android emulator, run the app against Metro, and capture screenshots via adb (Linux/KVM friendly). One-time setup: `vp run mobile:android-doctor`. Full guide: `docs/android-emulator-screenshots.md`
- `vp run mobile:ios-shots` - Boot an iOS simulator, run the app against Metro, and capture screenshots via `xcrun simctl` (macOS only). Full guide: `docs/ios-simulator-screenshots.md`
- `vp run dev:backend` - Start database and backend only
- `vp run dev:web` - Start database and web server only
- `vp run db:up` - Start development databases and run migrations only
- `vp run build` - Build all packages (dependency graph handles ordering and parallelism)
- `vp run build:web` - Build web package and its dependencies
- `vp run build:backend` - Build backend package and its dependencies
- `vp run typecheck` - Type check all packages (builds dependencies first)
- `vp run typecheck:web` - Type check web package only
- `vp run typecheck:backend` - Type check backend package only
- `vp run typecheck:db` - Type check db package only
- `vp run typecheck:shared` - Type check shared-schema package only
- `vp run check:i18n` - Scan `packages/web/app/**/*.tsx` for hardcoded user-facing English strings. Runs in CI on every PR; fails the build if a new untranslated string is introduced. Run `bun packages/web/scripts/check-untranslated-strings.ts --fix` to bulk-insert `// i18n-ignore-next-line` markers above existing violations.
- `bun run backend:start` - Start backend in production mode

### Running E2E Tests

- `vp run test:e2e` - Full Playwright run: brings up the pre-built dev DB, exports the seeded test user, and runs every spec in `packages/web/e2e/`. Playwright's `webServer` config auto-starts `vp run dev` (backend + web) for you.
- `vp run test:e2e:setup` - Only bring up the dev DB. Useful when iterating on a single spec: after setup, run `bun run --filter=@boardsesh/web test:e2e -- e2e/<spec>.spec.ts` (or use `test:e2e:ui` for the Playwright UI).
- The seeded test user is `test@boardsesh.com` / `test`, exported as `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` by the script so screenshot specs (`help-screenshots`, `layout-screenshots`) run end-to-end without 1Password.

### Database Commands (run from root or packages/db/)

- `vp run db:migrate` - Start dev DB and apply migrations
- `vp run db:studio` - Start dev DB and open Drizzle Studio for database exploration
- From packages/db: `bunx drizzle-kit generate` - Generate new migrations

### Creating Database Migrations

**IMPORTANT**: Always use `bunx drizzle-kit generate` from `packages/db/` to create new migrations. This command:

1. Detects schema changes in `packages/db/src/schema/`
2. Generates the SQL migration file in `packages/db/drizzle/`
3. Automatically adds the migration to `packages/db/drizzle/meta/_journal.json`

**Never manually create migration SQL files** without adding them to `_journal.json`. The journal tracks which migrations drizzle-kit should run - migrations missing from the journal will be silently skipped during deployment.

```bash
# From packages/db directory:
bunx drizzle-kit generate

# Then apply locally to test:
vp run db:migrate
```

## Architecture Overview

### Routing Pattern

The app uses deeply nested dynamic routes:

```
/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/...
```

- Routes mirror the API structure at `/api/v1/...`
- Board names: "kilter", "tension"
- All route segments are required for board-specific pages

We are using next.js app router, it's important we try to use server side components as much as possible.

### Key Architectural Components

#### Context Providers

1. **BoardProvider** (`packages/web/app/components/board-provider-context.tsx`)
   - Manages authentication and user sessions
   - Handles logbook entries and ascent tracking
   - Uses IndexedDB for offline persistence

2. **QueueProvider** (`packages/web/app/components/queue-control/queue-context.tsx`)
   - Manages climb queue with reducer pattern
   - Integrates with search results and suggestions
   - Syncs with backend via GraphQL subscriptions

#### Data Flow

1. **Server Components**: Initial data fetching in page components
2. **Client Components**: Interactive features with React Query (`@tanstack/react-query`) for data fetching
3. **API Routes**: Two patterns:
   - `/api/internal/...` - Server-side data operations
   - `/api/v1/[board]/proxy/...` - Aurora API proxies
4. **State Management**: React Context + useReducer for complex state

### Database Schema

- Separate tables for each board type (kilter*\*, tension*\*)
- Key entities: climbs, holds, layouts, sizes, sets, user_syncs
- Stats tracking with history tables
- See `packages/db/src/schema/` for full schema (re-exported via `packages/web/app/lib/db/schema.ts`)

### Key Integration Points

1. **Web Bluetooth**: Board LED control via Web Bluetooth API
2. **GraphQL-WS Backend**: Real-time collaboration via WebSocket GraphQL subscriptions
3. **Redis**: Pub/sub for multi-instance backend scaling
4. **IndexedDB**: Offline storage for auth and queue state
5. **Aurora API**: External API integration for user data sync

### Type System

- Core types in `packages/web/app/lib/types.ts`
- Shared types in `packages/shared-schema/src/types.ts`
- GraphQL schema in `packages/shared-schema/src/schema.ts`
- Zod schemas for API validation
- Strict TypeScript configuration

### Testing

- Tests use Vitest via Vite+ (`vp test`)
- Run `vp test run --reporter=agent` for CI-friendly output
- Run `vp test --project web` to run only web tests
- Run `vp test --project backend` to run only backend tests
- Backend tests auto-start a postgres+redis docker stack via `packages/backend/docker-compose.test.yml` (idempotent, left running between runs). Set `SKIP_TEST_INFRA=1` to skip orchestration; set `CI=1` to rely on caller-provided services.
- `packages/db` uses Node.js native test runner (`tsx --test`), not Vitest

## Development Guidelines

### Important rules

- **Validation must go through `vp` — never `bun run`, `bunx`, or `npx`.** This repo's toolchain is Vite+ (`vp`). For lint, format, typecheck, test, build, and dev, use `vp` and `vp run` exclusively. Do not invoke `bun run check`, `bun run lint`, `bun run test`, `bun run --filter=... typecheck`, `bunx tsc`, `npx eslint`, etc. — they bypass the unified config, can mutate `bun.lock`, and skip the typecheck/lint settings wired into `vite.config.ts`. The only sanctioned non-`vp` invocations are: (a) `bunx drizzle-kit generate` for migrations (no `vp` wrapper exists), and (b) `bun run backend:start` for production backend startup. If you find yourself reaching for `bun run` or `bunx` for anything else, stop and use the `vp` equivalent.
- **Use `vp check` or `vp run typecheck` instead of `vp run build` for validation** - Running build interferes with the local dev server and `bunx` commands can mess with lock files. `vp check` runs lint + format (the staged pre-commit hook calls `vp check --fix`). TypeScript type checking is run separately via `vp run typecheck` and in the typecheck CI job — `lint.options.typeCheck` is intentionally off in `vite.config.ts` because oxlint's type-aware mode surfaces a backlog of pre-existing violations across bundled assets and unrelated files. Run `vp run typecheck` (or one of `vp run typecheck:web|backend|db|shared`) before pushing.
- Always try to use server side rendering wherever possibe. But do note that for some parts such as the QueueList and related components, thats impossible, so dont try to force SSR there.
- Always use MUI (Material UI) components and their properties.
- Try to avoid use of the style property
- Always use design tokens from `packages/web/app/theme/theme-config.ts` for colors, spacing, and other design values - never use hardcoded values
- Always use CSS media queries for mobile/responsive design
- For rendering avoid JavaScript breakpoint detection & Grid.useBreakpoint()
- While we work together, be careful to remove any code you no longer use, so we dont end up with lots of deadcode
- Prefer skeleton or shadow content for loading states. Use spinners only when representative placeholder content is not reasonably possible, such as a single indeterminate action with no stable content shape.
- **Dark mode uses white input fields** — This is intentional for contrast. All input components (TextField, Select, Autocomplete, etc.) have white backgrounds in dark mode via `darkTokens.semantic.inputSurface`. Do not change them to dark backgrounds.
- **Never use `any` type** - The `no-explicit-any` lint rule is set to `deny` across all packages. Use `unknown`, proper types, or `as unknown as SpecificType` for type assertions. No exceptions - `any` defeats the purpose of TypeScript
- **Never hardcode user-facing strings** - All visible text must come from the i18n catalogs in `packages/web/i18n/locales/`. See the Internationalisation section below for the call-site pattern. CI runs `vp run check:i18n` on every PR, which fails the build if a `.tsx` file under `packages/web/app/` introduces a hardcoded English string. Pre-existing violations are silenced with `// i18n-ignore-next-line` (or `{/* i18n-ignore-next-line */}`) comments — chip away at these by translating them and removing the marker.
- **Variable names must describe their contents** - No single-letter aliases (`r`, `x`, `s`) or vague placeholders (`data`, `info`, `latest`, `temp`, `value`) outside of tight loops or well-known math conventions. The name should tell the next reader what's inside without forcing them to scroll back to the declaration. Prefer destructuring at the use site over a generic alias — `const { queue, currentClimb } = stateRef.current` reads better than `const s = stateRef.current` followed by `s.queue` / `s.currentClimb`.

### Internationalisation

Boardsesh ships English (`en-US`) at root paths and Spanish (`es`) at `/es/*`. The i18n stack is `i18next` + `react-i18next` with JSON catalogs under `packages/web/i18n/locales/<locale>/<namespace>.json`. Locale detection is path-based — middleware (`packages/web/middleware.ts`) reads the `/es/` prefix, rewrites the URL internally, and sets the `x-boardsesh-locale` request header.

**Adding new copy**

- Add the key to the matching English catalog only: `packages/web/i18n/locales/en-US/<namespace>.json`. Spanish catalogs are filled by community contributors. Missing Spanish keys fall back to English automatically (i18next `fallbackLng`).
- Pick the right namespace. Currently `common` (shared chrome) and `marketing` (about/help/docs/legal/privacy/home). Add a new namespace by adding it to `SEED_NAMESPACES` in `packages/web/app/lib/i18n/config.ts` and creating `<lang>/<namespace>.json` files for each supported locale.
- Use ICU-style placeholders for interpolation: `"greeting": "Hello {{name}}"`.

**Server components**

```ts
import { getServerTranslation } from '@/app/lib/i18n/server';

export default async function Page() {
  const { t } = await getServerTranslation('marketing');
  return <h1>{t('about.headerTitle')}</h1>;
}
```

**Client components** (`'use client'`)

```tsx
import { useTranslation } from 'react-i18next';

export default function Foo() {
  const { t } = useTranslation('marketing');
  return <span>{t('home.hero.title')}</span>;
}
```

**Internal links** must preserve the active locale — use `<LocaleLink>` (from `@/app/components/i18n/locale-link`), not raw `next/link`. For MUI links: `<MuiLink component={LocaleLink} href="/docs">`. External links (`https://`, `mailto:`) and `router.push()` calls are unaffected for now (locale-preserving navigation helpers for `router.push` are a follow-up).

**Page metadata** must use the locale-aware helper — `createPageMetadata` already populates `alternates.languages` (en-US, es, x-default) when given a `path`:

```ts
export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.foo.title'),
    description: t('metadata.foo.description'),
    path: '/foo',
    locale,
  });
}
```

**Inline formatting** (`<strong>`, `<em>`, links inside a paragraph) — prefer splitting into label/body keys for simple cases. For prose with multiple inline tags, use react-i18next's `<Trans components={{ em: <em />, strong: <strong /> }}>` so translators see the sentence as one unit. See `packages/web/app/legal/legal-content.tsx` for the `<Trans>` pattern.

**Adding a new page**

- Make it reachable at both `/path` (English) and `/es/path` (Spanish). Verify in the dev server.
- Use `generateMetadata` with the pattern above so hreflang alternates are emitted.
- Add the URL to `packages/web/app/sitemap.ts` if it should be indexable — sitemap entries automatically get per-locale variants.

**Adding a new locale**

Touch all of: `SUPPORTED_LOCALES` and `LOCALE_HTML_LANG`/`LOCALE_OG`/`LOCALE_LABELS` in `packages/web/app/lib/i18n/config.ts`, every catalog directory under `packages/web/i18n/locales/`, the language switcher options, and the sitemap. `detectLocale` (`packages/web/app/lib/i18n/detect-locale.ts`) iterates `SUPPORTED_LOCALES` and needs no edit — adding the locale to `config.ts` is sufficient for routing. Don't ship a partial locale — middleware will rewrite paths but pages will fall back to English everywhere.

**Don't translate** code samples in `<pre>` blocks (e.g. `app/docs/docs-client.tsx`), brand names ("Boardsesh", "Kilter", "Tension", "MoonBoard"), or user-generated content (climb names, comments, usernames). Trademark phrasing in CLAUDE.md still applies.

A handful of style rules are enforced as oxlint errors so they fail `vp check`. See `.oxlintrc.json` for the exact rule names and config; the current lint-enforced set includes `typescript/no-explicit-any` (no `any`), `no-nested-ternary`, `no-restricted-globals` (no `localStorage` / `sessionStorage`), and `no-restricted-imports` (no raw Neon `sql` client from `@/app/lib/db/db`).

### Copy & Microcopy

When writing user-facing text, follow these rules:

- Describe what the user gets, not what the feature does. "Line up your climbs before you get to the gym" is better than "Organize climbs into collections for your sessions."
- Users opened the app for a reason. Don't ask "Ready to climb?" when you can say "Get on the wall."
- If a sentence has three commas, it's a feature list in disguise. Pick the strongest point or break it up.
- Write like a climber talks. "Sends", "crew", "beta", "project" over "hub", "platform", "all-in-one solution."
- Empty states, error messages, and button labels carry the voice too. "No one's here yet" over "No data available."
- Use active verbs in CTAs. "See the feed", "Build a playlist", "Start climbing." Avoid "Go to..." and "View your..."
- Frame migrations and warnings around what users gain, not what they lose.
- Watch for AI-writing tells: em dash overuse, "not only X but Y" constructions, triple parallel structures, bolded-keyword-colon-explanation bullets, and generic adjectives like "seamless" or "comprehensive." See https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing

## SEO for New Pages

When adding a new route in `packages/web/app/`, decide up front whether it is a search surface or a utility surface. Do not let every page default to "indexable".

### Decide if the page should rank

- Treat landing pages, public board pages, climb view pages, public profiles, public setter pages, and public playlists as SEO surfaces by default.
- Treat `/auth`, `/settings`, `/join`, `/notifications`, session utilities, and similar signed-in flows as non-SEO surfaces by default.
- Treat alternate experiences like `/play/...` as duplicate or utility surfaces unless there is a strong reason to index them separately.
- If a page is private, auth-gated, ephemeral, or only useful inside an active session, default to `robots: { index: false, follow: true }`.

### Metadata requirements

- Every indexable page must define a unique `title`, `description`, canonical URL via `alternates.canonical`, Open Graph metadata, and Twitter metadata.
- Every non-indexable page must set an explicit `robots` directive instead of relying on default behavior.
- Avoid generic metadata like `Profile | Boardsesh`, `Playlist | Boardsesh`, `Play Mode | Boardsesh`, or `View details and climbs`.
- Prefer title formats like `Topic or Entity | Boardsesh`.
- Lead titles with the thing people actually search for, then the brand.
- Match search intent naturally in titles and descriptions. Descriptive phrases like `Kilter Board app alternative` are okay when the page clearly states Boardsesh is a compatible alternative and not the official Kilter app.

Good examples:

- `Kilter Board App Alternative | Boardsesh`
- `MoonBoard Screenshot Import | Boardsesh`
- `Marco's Kilter Sessions | Boardsesh`

Bad examples:

- `Home | Boardsesh`
- `Profile | Boardsesh`
- `Play Mode | Boardsesh`

### First-render content requirements

- If a page should rank, the first server-rendered HTML must include meaningful public content.
- Ship one clear `h1`, one or more descriptive paragraphs, and crawlable internal links near the top of the page.
- Put primary copy above heavy widgets, drawers, or client-only controls.
- Do not ship an indexable page whose first render is only a spinner, app shell, board canvas, or client-fetched placeholder.
- If the important content can only be loaded client-side, either move the summary content into a server component or mark the page `noindex`.

### Canonical and noindex defaults

- Canonicalize filtered, sorted, paginated, and query-param variants to the clean base page unless the variant is intentionally indexable as its own document.
- Canonicalize alternate experiences to the primary route. In this app, `/play/...` should normally point to the equivalent `/view/...` route.
- Keep private, auth-gated, utility, and session-entry routes out of the index.
- Do not let duplicate numeric and slug-based URLs compete if one is the preferred public route.

### Internal linking requirements

- Important public pages must be reachable through crawlable `Link href` or `<a href>` links.
- Do not rely on `router.push`, clickable cards built from `div`s, or button-only flows for key SEO destinations.
- Every new indexable page should have at least 2 to 3 meaningful internal links to or from other public pages.
- Use descriptive anchor text like `Browse Kilter climbs`, `Migrate from the old Kilter app`, or `Open Marco's profile` instead of generic text like `Click here` or `Learn more`.

### Structured data defaults

- Use JSON-LD when the page type clearly supports it.
- Homepage: consider `Organization` and `WebSite`.
- Page hierarchies: consider `BreadcrumbList`.
- Public profile-like pages: consider `ProfilePage`.
- Only add structured data that matches the visible content on the page.
- Validate rich-result markup before shipping when relevant.

### Sitemap inclusion

- Review sitemap generation whenever you add a new public page type.
- Add only public, canonical, indexable URLs to the sitemap.
- Keep utility, duplicate, filtered, query-param, and auth-only routes out of the sitemap.
- Use real content timestamps where possible instead of setting every entry to the current time.

### Boardsesh-specific examples

- Public board pages, climb view pages, migration pages, and search-focused landing pages are SEO surfaces.
- Settings, auth, session-join flows, notifications, and alternate `/play/...` views are non-SEO surfaces by default.
- If you add a new public page type, update the sitemap implementation in `packages/web/app/sitemap.ts` or its replacement sitemap handlers in the same change.
- Prefer server components for page summaries and metadata generation wherever possible.
- Reconcile keyword targeting with trademark-safe wording: describe compatibility and alternatives clearly, but never imply endorsement or affiliation.

### Pre-ship SEO checklist

- Is this page supposed to rank?
- Does it have unique metadata and a canonical URL?
- Does the first server-rendered HTML contain useful copy without hydration?
- Should it be `noindex` instead?
- Can crawlers reach it through normal links?
- Should it be added to the sitemap?
- If trademarked board names are used, is the wording descriptive and non-affiliative?

### Trademark Usage (Kilter, Tension, MoonBoard)

- Always capitalize correctly: **MoonBoard** (not Moonboard), **Kilter**, **Tension**
- Use names to describe compatibility, not to brand Boardsesh: "Works with Kilter" not "Kilter app"
- Prefer "your" to signal the user's hardware: "One app for your boards" not "One app for Kilter"
- Never imply endorsement or affiliation with Aurora Climbing, Moon Climbing, or any manufacturer
- See `/legal` route and `LEGAL.md` for the full trademark disclaimer

### Component Structure

- Server Components by default
- Client Components only when needed (interactivity, browser APIs)
- Feature-based organization in `packages/web/app/components/`

### API Development

- Follow existing REST patterns
- Use Zod for request/response validation
- Implement both internal and proxy endpoints as needed

### Database Queries: Prefer Drizzle ORM

**Always use Drizzle ORM query builder** (`db.select()`, `db.insert()`, `db.update()`, `db.delete()`) for database operations. Only fall back to raw SQL (`sql` template literals from `drizzle-orm`) when the query genuinely cannot be expressed with the query builder (complex JOINs with type casts, window functions, CTEs, EXISTS subqueries, complex aggregations).

- Importing `sql` from `@/app/lib/db/db` (the raw Neon HTTP client) is blocked by lint (`no-restricted-imports`). Use Drizzle's `db` instance instead (`getDb()` or `dbz`).
- When raw SQL is necessary, use `db.execute(sql`...`)` with Drizzle's `sql` from `drizzle-orm` — not the Neon HTTP client directly.
- Both are safe from SQL injection (parameterized), but Drizzle gives you type safety and schema awareness.

### Client-Side Storage: IndexedDB Only

All client-side persistence must use IndexedDB via the `idb` package. Bare `localStorage` and `sessionStorage` references are blocked by lint (`no-restricted-globals`); the only legitimate uses are one-time migration code that reads old data and deletes it, plus a couple of e2e test affordances that need synchronous reads at render time. Mark those sites with `// oxlint-disable-next-line no-restricted-globals` and a short reason. Do not bypass the rule by writing `window.localStorage` / `window.sessionStorage` — write the bare global and disable the rule explicitly so the exception is greppable.

- **Simple key-value preferences** (e.g., view mode, party mode): Use the shared utility at `packages/web/app/lib/user-preferences-db.ts` which provides `getPreference<T>(key)`, `setPreference(key, value)`, and `removePreference(key)`.
- **Domain-specific data** (e.g., recent searches, session history, onboarding status): Create a dedicated `*-db.ts` file in `packages/web/app/lib/` following the established pattern (lazy `dbPromise` init, SSR guard, try-catch error handling). See `tab-navigation-db.ts` or `onboarding-db.ts` for examples.
- All IndexedDB access must be guarded with `typeof window === 'undefined'` checks for SSR compatibility.
- When migrating a value from `localStorage` to IndexedDB, include one-time migration logic that reads the old key, writes to IndexedDB, and deletes the localStorage key. See `user-preferences-db.ts` (`getPreference` fallback), `recent-searches-storage.ts`, and `party-profile-db.ts` for examples.

### State Management

- URL parameters as source of truth for board configuration
- Context for cross-component state
- IndexedDB for persistence

### Mobile Considerations

- iOS Safari lacks Web Bluetooth support
- Recommend Bluefy browser for iOS users
- Progressive enhancement for core features
