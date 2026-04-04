# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Boardsesh is a monorepo containing a Next.js 15 application for controlling standardized interactive climbing training boards (Kilter, Tension). It adds missing functionality to boards using Aurora Climbing's software, including queue management and real-time collaborative control.

## Project Rules

- Work autonomously end-to-end. Backend + frontend + deploy + QA. Never stop at "the API is ready but the UI isn't updated."
- Use subagents (always Opus) for all grunt work. Pair every implementation subagent with a QA/reviewer subagent.
- Work high-level: divide work, subagents execute, you orchestrate and fix issues.
- No AI-generated images ever. Real photos or diagrams only.
- No buzzwords. Concrete numbers and simple language.
- Keep `REQUESTS.md` updated as the feature backlog. Mark items as you complete them.
- No unnecessary check-ins. Default to action. Full autonomy except no data deletion without asking.
- **Performance is critical.** Every change must be reviewed for performance impact. After implementing changes, always spawn a dedicated performance review subagent (Opus) that audits the diff for: unnecessary re-renders, expensive computations in hot paths, unoptimized database queries, missing memoization, bundle size regressions, and N+1 query patterns. Do not merge or finalize work until the performance review passes.

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

The development database uses a **pre-built Docker image** (`ghcr.io/boardsesh/boardsesh-dev-db`) that already contains all Kilter, Tension, and MoonBoard board data, a test user, and social seed data with migrations applied. This means `bun run db:up` is fast — it just pulls the image, starts containers, and runs any newer migrations.

```bash
# Start development databases (PostgreSQL, Neon proxy, Redis)
# First run pulls the pre-built image (~1GB) with all board data included.
# Subsequent runs start in seconds.
# Test user: test@boardsesh.com / test
bun run db:up

# Environment files are in packages/web/:
# .env.local contains generic config (tracked in git)
# .env.development.local contains secrets (NOT tracked in git)

# For shared sync to work, add Aurora API tokens to packages/web/.env.development.local:
KILTER_SYNC_TOKEN=your_kilter_token_here
TENSION_SYNC_TOKEN=your_tension_token_here

# Note: VERCEL_URL is automatically set by Vercel for deployments
# For local development, the app defaults to http://localhost:3000

# Install all dependencies (from root)
bun install

# Start web development server
bun run dev

# Start backend development server
bun run backend:dev
```

#### Pre-built database image

The `boardsesh-dev-db` image is published to GHCR and contains PostgreSQL 17 + PostGIS with all Kilter/Tension/MoonBoard board data pre-loaded, a test user (`test@boardsesh.com` / `test`), social seed data (fake users, follows, ticks, comments, notifications), and all drizzle migrations applied. It is rebuilt automatically when files in `packages/db/docker/`, `packages/db/scripts/`, `packages/db/src/schema/`, `packages/db/drizzle/`, or `packages/db/package.json` change on main.

- **Pull directly**: `docker pull ghcr.io/boardsesh/boardsesh-dev-db:latest`
- **Reset your local database**: `docker compose down -v && bun run db:up`
- **Build locally** (e.g. to test Dockerfile changes): `docker compose up -d --build postgres`

### Common Commands (from root)

- `bun run dev` - Start web development server with Turbopack
- `bun run build` - Build all packages
- `bun run build:web` - Build web package only
- `bun run build:backend` - Build backend package only
- `bun run lint` - Run oxlint on web package
- `bun run typecheck` - Type check all packages (use this instead of build for validation)
- `bun run typecheck:web` - Type check web package only
- `bun run typecheck:backend` - Type check backend package only
- `bun run typecheck:db` - Type check db package only
- `bun run typecheck:shared` - Type check shared-schema package only
- `bun run backend:dev` - Start backend in development mode
- `bun run backend:start` - Start backend in production mode
- `bun run db:up` - Start development databases, run migrations, and import MoonBoard data (uses pre-built image with Kilter/Tension data)

### Database Commands (run from root or packages/db/)

- `bun run db:migrate` - Apply migrations (also runs on Vercel build)
- `bun run db:studio` - Open Drizzle Studio for database exploration
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
bun run db:migrate
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
2. **Client Components**: Interactive features with SWR for data fetching
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

- Vitest configured but tests not yet implemented
- Run tests with `bun test` when available

## Development Guidelines

### Important rules

- **Use `bun run typecheck` instead of `bun run build` for TypeScript validation** - Running build interferes with the local dev server and `bunx` commands can mess with lock files. Use the typecheck scripts for validating TypeScript.
- Always try to use server side rendering wherever possibe. But do note that for some parts such as the QueueList and related components, thats impossible, so dont try to force SSR there.
- Always use MUI (Material UI) components and their properties.
- Try to avoid use of the style property
- Always use design tokens from `packages/web/app/theme/theme-config.ts` for colors, spacing, and other design values - never use hardcoded values
- Always use CSS media queries for mobile/responsive design
- For rendering avoid JavaScript breakpoint detection & Grid.useBreakpoint()
- While we work together, be careful to remove any code you no longer use, so we dont end up with lots of deadcode
- **Never use `any` type** - The `no-explicit-any` lint rule is set to `deny` across all packages. Use `unknown`, proper types, or `as unknown as SpecificType` for type assertions. No exceptions - `any` defeats the purpose of TypeScript

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

- **Never use the raw Neon `sql` client** (`import { sql } from '@/app/lib/db/db'`) for new code. Use Drizzle's `db` instance instead (`getDb()` or `dbz`), which provides type safety and schema validation.
- When raw SQL is necessary, use `db.execute(sql`...`)` with Drizzle's `sql` from `drizzle-orm` — not the Neon HTTP client directly.
- Both are safe from SQL injection (parameterized), but Drizzle gives you type safety and schema awareness.

### Client-Side Storage: IndexedDB Only

**Never use `localStorage` or `sessionStorage`**. All client-side persistence must use IndexedDB via the `idb` package.

- **Simple key-value preferences** (e.g., view mode, party mode): Use the shared utility at `packages/web/app/lib/user-preferences-db.ts` which provides `getPreference<T>(key)`, `setPreference(key, value)`, and `removePreference(key)`.
- **Domain-specific data** (e.g., recent searches, session history, onboarding status): Create a dedicated `*-db.ts` file in `packages/web/app/lib/` following the established pattern (lazy `dbPromise` init, SSR guard, try-catch error handling). See `tab-navigation-db.ts` or `onboarding-db.ts` for examples.
- All IndexedDB access must be guarded with `typeof window === 'undefined'` checks for SSR compatibility.
- When migrating a value from `localStorage` to IndexedDB, include one-time migration logic that reads the old key, writes to IndexedDB, and deletes the localStorage key. See `user-preferences-db.ts` (`getPreference` fallback), `recent-searches-storage.ts`, and `party-profile-db.ts` for examples.
- The only acceptable `localStorage` references are in one-time migration code that reads old data and deletes it.

### State Management

- URL parameters as source of truth for board configuration
- Context for cross-component state
- IndexedDB for persistence

### Mobile Considerations

- iOS Safari lacks Web Bluetooth support
- Recommend Bluefy browser for iOS users
- Progressive enhancement for core features
