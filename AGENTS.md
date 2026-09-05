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

Boardsesh is a monorepo. Next.js 16 web app + React Native (Expo) mobile app for controlling Kilter / Tension / MoonBoard climbing boards. Adds queue management and real-time collaborative control on top of Aurora Climbing's software.

## Project Rules

- Backend work belongs in `packages/backend` (GraphQL), not in the Next.js app. We are slowly moving REST/server logic out of `packages/web`.
- Work autonomously end-to-end: backend + frontend + QA. Don't stop at "API is ready but UI isn't updated."
- Use subagents (always Opus) for grunt work. Pair every implementation subagent with a QA/reviewer subagent.
- No AI-generated images. Real photos or diagrams only.
- No buzzwords. Concrete numbers, plain language.
- Default to action. Full autonomy except no data deletion without asking.
- **Bluetooth changes require a Fable review.** Any change touching Bluetooth/BLE code — `packages/shared/ble-protocol/`, `packages/mobile/src/lib/ble/`, `packages/mobile/modules/live-activity/ios/`, or the web Bluetooth LED control in `packages/web` — must be reviewed by Fable before merge.

## PR Lifecycle (mandatory)

We'll always create a PR, never asks if a PR should be created, open as a draft. After every PR is created, **always** subscribe to PR feedback until the PR is merged or closed.

- **CI failures**: diagnose and push a fix. Retry until green. If a failure is genuinely out of scope, explain and block on the user.
- **Merge conflicts**: rebase on `main` and `git push --force-with-lease` — don't ask first.
- **Review feedback**: fix minor, cosmetic, and style comments autonomously and push. For correctness disagreements, architectural changes, or ambiguous instructions, use `AskUserQuestion` before acting.
- **Release notes**: every PR description must include the `## Release Notes` section from the PR template. Write in climber voice — describe what the user gets, not what the code does. Internal-only changes (refactor, CI, deps, tests) get `none`.
- **Test plan + Risk**: every PR description carries a `## Test plan` and a `## Risk` section (template). Testers read the plan word for word in the mobile app, so write it for a distracted reader on a phone: 1–5 numbered steps, each one action then what they should see ("You tab → Log a tick → field grows"), 12 words or fewer per step, no preamble. **Write what a tester taps and sees, never what you ran** — no commands, no repo paths, no CI log steps; the gate rejects them, and author-side verification belongs in the Summary. "1. CI green." is the whole plan for an internal change. Risk is `Risk: N/5 — why` (1 docs/CI/deps · 3 new screen or resolver · 5 BLE/OTA/migrations). `pr-test-plan.yml` fails without both; testers' verdicts come back as `qa-approved` / `qa-declined` labels. See `docs/crowdsourced-qa.md`.
- **Ready to merge signal**: once CI is green, no unresolved review comments remain, and there are no conflicts, remove the draft status from the PR marking it ready for review.

## Monorepo Structure

```
/packages/
  /web/             # Next.js web application
  /mobile/          # React Native (Expo) mobile application
  /backend/         # WebSocket backend for party mode (graphql-ws)
  /shared-schema/   # Shared GraphQL schema and TypeScript types
  /board-constants/ # Generated Aurora board catalogue (sizes, layouts, sets, holds), grade colours, difficulty bands
  /shared/
    /play-view/     # Play-drawer logic (queue nav, tick utils, grade display)
    /queue/         # Queue state machine (reducer, types, event utils)
    /board-config/  # Board metadata, hold maps, angle tables
    /board-react/   # Renderer-agnostic BoardProvider + logbook/tick hooks (useSaveTick/useUpdateTick/useDeleteTick)
    /offline-sync/  # Offline sync engine: mutation outbox + drainer, pull client, SQLite DDL (platform I/O injected)
    /profile-stats/ # Pure climbing-stats aggregation for the You page / profile (chart builders, deriveProfileViewModel)
    /ble-protocol/  # Bluetooth LED control protocol
  /db/              # Shared database schema, client, migrations (drizzle)
```

## Shared Packages (Web ↔ Mobile)

Code reuse between web and mobile is the highest priority when adding cross-platform features. Before writing platform-specific logic, check whether the same behaviour already exists on the other side and extract the shared part into `packages/shared/`.

- **One responsibility per package.** Name packages after what they do (`@boardsesh/queue`, `@boardsesh/play-view`). No mega-`@boardsesh/shared`.
- **Default to pure TS; renderer-agnostic React goes in dedicated `*-react` packages.** Most shared packages stay pure TS (types, pure functions, constants, state machines) with no React at all. When web and mobile would genuinely share React hooks / context / reducers, put them in a `@boardsesh/*-react` package (e.g. `@boardsesh/queue-react`, `@boardsesh/board-react`) that lists `react` as a `peerDependency`. Such packages must stay renderer-agnostic — **no** `react-dom`, `next`, DOM globals, or MUI (web); **no** `react-native` host components or Expo APIs (mobile). Inject every platform I/O (GraphQL clients, storage, navigation, toasts) as parameters.
- **No circular deps.** Shared packages may depend on other shared packages, never on `web`, `mobile`, or `backend`.
- **Extract, don't duplicate.** When porting a web feature to mobile, pull the business logic into a shared package and update web to import from it in the same PR.
- **Tests live next to the code** in `src/__tests__/`.

## Commands

Toolchain is [Vite+](https://viteplus.dev) (`vp`), which manages the package manager for you — `vp install` downloads the pnpm pinned in `packageManager` and drives it. **Never use `pnpm run`, `npm run`, `npx`, or a raw `pnpm install` for validation** — they bypass the unified config and can mutate `pnpm-lock.yaml`. Use `vp exec <bin>` for a workspace binary and `vp dlx <pkg>@<ver>` for a pinned remote one. The only sanctioned non-`vp` invocations are `vp exec drizzle-kit generate` (migrations) and `pnpm --filter boardsesh-backend run start` (prod backend).

Use `vp check` or `vp run typecheck` to validate — **not** `vp run build` (build interferes with the dev server). `vp check` runs lint + format (the staged pre-commit hook calls `vp check --fix`). Run `vp run typecheck` before pushing.

Common commands:

- `vp check` — format + lint (canonical validation; pre-commit)
- `vp test` / `vp test run --reporter=agent` — tests (always use `--reporter=agent` to save context)
- `vp test run --project web|backend|mobile` — scope tests. **`--project` MUST come after `run`.** `vp test --project mobile run` (flag before `run`) silently treats the name as a filename filter and runs ~1 file — a false green. Prefer the footgun-proof aliases `vp run test:mobile` / `vp run test:web`.
- `vp run dev` — start DB + backend + web
- `vp run dev:mobile` — start mobile dev server (Metro)
- `vp run dev:mobile:web` — start the env-gated Expo browser app behind Next at `/app`
- `vp run db:up` / `vp run db:migrate` / `vp run db:studio`
- `vp run build`, `vp run typecheck` (+ `:web`, `:backend`, `:mobile`, `:db`, `:shared`)
- `vp run check:i18n` — fails on hardcoded English strings under `packages/web/app/`
- `vp run check:mobile-bundle` — headless Metro bundle check (Linux-safe)
- `vp run check:mobile-web-bundle` — export the Expo browser app and verify the shell/WASM assets
- `vp run check:mobile-simulator`, `vp run mobile:screenshot` — macOS only
- `vp run mobile:ios` — local Expo iOS build with the shared Boardsesh Xcode cache
- `vp run mobile:publish` — EAS Update for current branch
- `vp run test:e2e` — Playwright; auto-starts the dev DB + web server

### Database

- `vp exec drizzle-kit generate` from `packages/db/` to create migrations. **Never hand-write migration SQL** — it must be in `_journal.json`, which `drizzle-kit generate` updates for you.
- Dev DB is a pre-built image (`ghcr.io/boardsesh/boardsesh-dev-db`) with all board data, a test user (`test@boardsesh.com` / `test`), and seed data. Reset: `docker compose down -v && vp run db:up`.

### Database hosting (Railway)

We host Postgres on Railway but treat it as portable — anything we write should run on a `docker run postgres:17`. No Railway-specific addons, env vars, build steps, or schema mutations via dashboard. `pg_dump`/`pg_restore` must be sufficient to lift-and-shift. Same rule for object storage / video / analytics: prefer S3-compatible APIs, OpenTelemetry exporters, standard connection strings. Exit runbook: `docs/neon-migration.md`.

## GitHub Issue Fix Workflow

When the request references an issue ("fix issue #N", "this GH issue", a bug link):

1. **Work in a fresh git worktree branched off the latest `main`.** Fetch `origin/main` first.
2. **Plan before implementing.**
3. **Pre-commit hook must pass** — fix underlying issues, no `--no-verify`.
4. **Write a QA notes file before starting the dev server.** `.boardsesh/qa-notes.md` is the default path the orchestrator auto-detects and injects for `curl http://localhost:3000/api/internal/dev-metadata` to confirm (dev-only; no in-app surface). Write it for the person testing, not as a record of what you did: the pages/flows to exercise, what they should see, and the edge cases worth poking. No commands, no file paths, no summary of your own verification. For an alternate path, pass `vp run dev -- --qa-notes-file <path>`. **Never start the dev server for an issue fix without QA notes.**
5. **Start the dev server with `vp run dev`** (web) or `vp run dev:mobile` (mobile). Confirm the startup log shows `[dev] QA notes: <path>`. For mobile, the orchestrator surfaces QA notes in the `DevMetadataPanel` (More tab); Metro output is tee'd to `.boardsesh/mobile-metro.log`.
6. **Tell the user the URL in one message** — whatever the server prints (typically `http://localhost:3000`). Don't paste the QA plan into chat; it's already in the file and the app.
7. **Always open a PR** once validated.

Ad-hoc edits and direct feature requests don't trigger this workflow. If the user opts out of a step, respect that for the current task only.

## Documentation

Read relevant `docs/` before working on the matching area; update docs when the system changes.

- `docs/websocket-implementation.md` — WebSocket party session architecture
- `docs/user-media-storage.md` — the two Cloudflare R2 buckets behind avatars, gym images, beta thumbnails and user data exports: why R2 rather than Tigris, the named-bucket env contract, the no-ACL rule R2 forces, and the Railway-bucket migration runbook
- `docs/boardsesh-grade.md` — Boardsesh grade: the data-science-backed universal climb grade (data sources + quirks, the empirical-Bayes model and every coefficient, validation gates, limitations, rejected alternatives, contributor roadmap)
- `docs/ai-design-guidelines.md` — Velvet Send design system (mobile-canonical: palette, typography, tokens, Liquid Glass / Material variants; web still on the legacy rose/sage palette, pending migration)
- `docs/live-activity-push-testing.md` — APNs Live Activity push testing
- `docs/logging.md` — backend structured logger (winston)
- `docs/crowdsourced-qa.md` — the PR test-plan + risk gate (`@boardsesh/pr-body`, `pr-test-plan.yml`), and the tester loop that turns it into `qa-approved` / `qa-declined` labels
- `docs/mobile-sheets-vs-routes.md` — mobile: which surface to use (bottom sheet vs route), with the decision tree + the hard rules (incl. why `fullScreenModal` breaks the iOS 26 native tab bar)

## Architecture Overview

### Web routing

Deeply nested dynamic routes: `/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/...`. Routes mirror `/api/v1/...`. Board names: `kilter`, `tension`. Next.js App Router — prefer server components wherever possible (queue/realtime components are necessarily client).

### Key components

The climbing UI (board provider, queue provider, play view, BLE control) moved to
the Expo app in W-16 (#4435) — www keeps marketing, account and gym surfaces only.

- **SiteChrome** (`packages/web/app/components/providers/site-chrome.tsx`) — the root chrome: `MarketingHeader` + `SiteFooter`, wrapped in the three bridges the surviving pages need (`StatsFilterBridgeProvider`, `ProfileHeaderShareProvider`, `PlaylistsAdapterProvider`).

### Data flow

- Server components fetch initial data.
- Client components use React Query.
- API: `/api/internal/...` for server-side ops; `/api/v1/...` for the public read API (climbs, grades, heatmaps, slugs). The Aurora proxies are gone: W-25a (#4441) retired them, W-25b (#4443) deleted the URLs. Board login and tick logging run on GraphQL.
- State: Context + `useReducer` for complex state; URL params as source of truth for board config.

### Integration points

GraphQL-WS backend (kiosk presence, comments, notifications), Redis (pub/sub for multi-instance), IndexedDB (client persistence), Aurora API (user sync). Web Bluetooth LED control is gone — BLE lives in the mobile app and `packages/shared/ble-protocol/`.

### Types

Web types in `packages/web/app/lib/types.ts`; shared types in `packages/shared-schema/src/types.ts`; GraphQL schema in `packages/shared-schema/src/schema.ts`. Zod for API validation.

### Testing

Vitest via `vp test`. Backend tests auto-start postgres+redis via `packages/backend/docker-compose.test.yml`; set `SKIP_TEST_INFRA=1` to skip, `CI=1` for caller-provided services. `packages/db` uses Node's native test runner (`tsx --test`).

## Development Guidelines

### Important rules

- **Never use `any`.** `typescript/no-explicit-any` is `deny` everywhere. Use `unknown` or `as unknown as T`.
- **Validation goes through `vp` only** (see Commands above).
- Always prefer server-side rendering. Queue/realtime components are the exception — don't force SSR there.
- **Web uses MUI.** Always MUI components and props. Avoid the `style` prop. Always use design tokens from `packages/web/app/theme/theme-config.ts` for colours/spacing — no hardcoded values.
- Use CSS media queries for responsive design. Avoid JS breakpoint detection (`Grid.useBreakpoint()`).
- Remove dead code as you go.
- **Dark mode uses white input fields.** Intentional for contrast (`darkTokens.semantic.inputSurface`). Do not change.
- **Never hardcode user-facing strings** in `packages/web/app/**/*.tsx` — all visible text via i18n catalogs. CI runs `vp run check:i18n` and `vp run check:i18n:orphans`. Mark unresolvable dynamic lookups with `// i18n-keep namespace.dotted.key`.
- **Variable names describe contents.** No single-letter aliases (`r`, `x`, `s`) or vague placeholders (`data`, `info`, `temp`, `value`) outside tight loops. Destructure at the use site instead of generic aliases.
- **Drizzle ORM over raw SQL.** Use `db.select/insert/update/delete()`. Raw `sql` from `drizzle-orm` only when the query genuinely can't be expressed otherwise. Importing `sql` from `@/app/lib/db/db` (raw Neon HTTP client) is lint-blocked.
- **IndexedDB only for client-side storage.** `localStorage`/`sessionStorage` are lint-blocked (`no-restricted-globals`). Use `packages/web/app/lib/user-preferences-db.ts` for simple key-value or create a domain-specific `*-db.ts` (see `tab-navigation-db.ts`, `onboarding-db.ts`). Always SSR-guard with `typeof window === 'undefined'`. One-time `localStorage` migration code is the only legitimate exception — mark with `// oxlint-disable-next-line no-restricted-globals`.

### Internationalisation

Supported locales: `en-US` (root), `es` (`/es/*`), `fr` (`/fr/*`), `de` (`/de/*`). Path-based detection via middleware (`packages/web/middleware.ts`). Catalogs in `packages/shared/i18n/locales/<locale>/<namespace>.json` (`@boardsesh/i18n`, shared by web and mobile). Namespaces: `common`, `marketing`, `auth`, and friends — add new ones to `ALL_NAMESPACES` in `packages/shared/i18n/src/config.ts` (web re-exports it as `SEED_NAMESPACES`; mobile ships the `MOBILE_NAMESPACES` subset).

- **Add every new key to every locale.** `catalog-completeness.test.ts` in `@boardsesh/i18n` enforces parity per namespace.
- Server: `const { t } = await getServerTranslation('marketing')`.
- Client: `const { t } = useTranslation('marketing')`.
- Internal links: `<LocaleLink>` from `@/app/components/i18n/locale-link` (not raw `next/link`). MUI: `<MuiLink component={LocaleLink} href="...">`.
- Page metadata: use `createPageMetadata({ title, description, path, locale })` for hreflang alternates.
- Inline formatting with multiple tags: react-i18next `<Trans>` (see `app/legal/legal-content.tsx`).
- Use ICU placeholders: `"greeting": "Hello {{name}}"`.
- **Don't translate** code samples in `<pre>` blocks, brand names (Boardsesh, Kilter, Tension, MoonBoard), or user-generated content.
- Linter hard-fails on `t(variable)` / `t('a' + b)` — use string literals or template literals only.

Adding a new locale: update `SUPPORTED_LOCALES` and friends in `packages/shared/i18n/src/config.ts`, add catalog dir, language switcher, sitemap.

**Spanish terminology:** Spanish translations follow a fixed glossary. Most importantly, a climbing board is **"plafón"** (masculine — _el plafón_, plural _plafones_), never "tabla"/"tablero"/"tabla de escalada" or raw English "board"; fix article/adjective agreement when you swap the word. Brand product names ("Kilter Board", "Tension Board", "MoonBoard") stay as-is. Full terminology, grammar rules, and exceptions: **`docs/i18n-spanish-glossary.md`** — follow it for every Spanish string you add.

**French terminology:** French translations follow a fixed glossary too. Most importantly, a climbing send is never **« envoyer »** — French climbers don't "send" a climb. The send status/verb is **« Enchaîné » / enchaîner**, the noun send is **« la croix »** (invariable: _dix croix_; « faire la croix » = tick it in the logbook), and lighting a climb on the wall is **« allumer »**, not « envoyer ». Attempts on a climb are « essais », never « tentatives ». Full terminology and exceptions: **`docs/i18n-french-glossary.md`** — follow it for every French string you add.

**German terminology:** German translations follow a fixed glossary. Product UI uses informal **du** and gender-star role nouns (`Routenbauer*in`). A climbing send is never **senden** — status/button is **Getoppt**, counts use **Begehung/Begehungen**, and lighting holds on the wall is **Board beleuchten**. The device is **Board** (neuter — _das Board_). Full terminology and exceptions: **`docs/i18n-german-glossary.md`** — follow it for every German string you add.

### Copy & microcopy

- Describe what the user gets, not what the feature does.
- Active verbs in CTAs. "See the feed", "Build a playlist", not "Go to..." / "View your...".
- Climber voice: "sends", "crew", "beta", "project" over "hub", "platform", "all-in-one solution".
- Empty states / error messages carry the voice too. "No one's here yet" over "No data available."
- Frame migrations and warnings around what users gain, not lose.
- Avoid AI-writing tells: em dash overuse, "not only X but Y", triple parallel structures, bolded-keyword-colon-explanation bullets, generic adjectives ("seamless", "comprehensive"). See https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing

### Trademark usage (Kilter, Tension, MoonBoard)

- Capitalise correctly: **MoonBoard**, **Kilter**, **Tension**.
- Describe compatibility, not branding: "Works with Kilter" not "Kilter app". "One app for your boards" not "One app for Kilter".
- Never imply endorsement of Aurora, Moon Climbing, or any manufacturer. See `/legal` and `LEGAL.md`.

## SEO for new web pages

Decide up front: is this a search surface (landing, public board, climb view, public profile, public setter, public playlist) or a utility surface (`/auth`, `/settings`, `/join`, `/notifications`, session flows, `/play/...`)? Default utility pages to `robots: { index: false, follow: true }`.

For indexable pages:

- Unique `title`, `description`, `alternates.canonical`, OG + Twitter metadata. No generic titles like `Profile | Boardsesh` — lead with what people search for (`Marco's Kilter Sessions | Boardsesh`).
- First server-rendered HTML must contain meaningful copy: one `h1`, descriptive paragraphs, crawlable links. No indexable spinner-only pages.
- Canonicalise filtered/sorted/paginated variants to the clean base URL. Canonicalise `/play/...` to the equivalent `/view/...`.
- Reachable via real `<a href>` / `Link href` — not `router.push` or click-handlers on `<div>`s. ≥2–3 internal links per page with descriptive anchor text.
- JSON-LD where it fits: `Organization`/`WebSite` (homepage), `BreadcrumbList` (hierarchies), `ProfilePage` (profiles).
- Add a shard (or extend one) in `packages/web/app/lib/seo/sitemap/shard-registry.ts` when adding a new public page type — `/sitemap.xml` is a `<sitemapindex>` over `/sitemaps/*.xml`. Real content timestamps, not `new Date()`.
- Keep trademark wording compatible-not-affiliative.

## Mobile Development (packages/mobile/)

React Native + Expo SDK 57, React Native 0.86, Expo Router 57.

### Stack

- **Routing**: `packages/mobile/app/` (Expo Router file-based)
- **Components**: `packages/mobile/src/components/` (native RN, no MUI)
- **Theme**: `packages/mobile/src/providers/theme-provider.tsx` (iOS system colors, spacing, radii)
- **Providers**: `packages/mobile/src/providers/` (auth, i18n, query, queue, theme)
- **Shared packages**: `@boardsesh/ble-protocol`, `@boardsesh/board-config`, `@boardsesh/board-constants`, `@boardsesh/queue`, `@boardsesh/shared-schema`
- **Bundler**: Metro via `packages/mobile/metro.config.js` (watches monorepo root)

### Mobile vs. web

- **Lint via `vp check`** — runs for mobile just like other packages. Use `vp run typecheck:mobile` for type-only checks.
- **Own i18n provider** at `packages/mobile/src/providers/i18n-provider.tsx`. No web i18n rules apply.
- **No web dev-server workflow** — use `vp run dev:mobile` (Metro) instead. The QA-notes-into-`/api/internal/dev-metadata` env injection is web-only (curl the route to confirm what a running dev server started with); on mobile the `DevMetadataPanel` (More tab) reads `.boardsesh/qa-notes.md` via env injection instead.
- **Styling**: `StyleSheet.create` + theme provider. No MUI, no `style`-prop avoidance rule.
- **Dev mode**: `__DEV__` global, not `process.env.NODE_ENV`.
- **Storage**: `expo-secure-store` for credentials, not IndexedDB.
- **Navigation**: Expo Router, not Next.js App Router.

### Expo web

The Expo app's browser target is opt-in with `BOARDSESH_WEB=1`. Keep web-only
configuration behind that gate so native OTA fingerprints do not change.

- Use `.web.ts(x)` forks or exact Metro web shims for native modules. Do not use
  `patch-package` for browser fixes because patched dependencies affect native
  fingerprints.
- `@gorhom/bottom-sheet` is a web-only implementation detail. It may be imported
  only by `packages/mobile/src/web-shims/bottom-sheet.tsx`; native and shared code
  must keep importing `@expo/ui/community/bottom-sheet`. Expo's Vaul-based web
  sheet renders, but does not implement the gesture-lock or keyboard contracts used
  by QueueSheet and LogAscentSheet, and adds a scroll container around virtualized
  sheet content. Keep Gorhom until those flows work against Expo's implementation;
  mobile-browser keyboard behaviour remains a real-device QA gate.
  Its isolated install is in `packages/mobile/web-runtime`; `vp` installs that
  nested lock for web/typecheck tasks without exposing React Native Web to the
  native fingerprint graph. Gorhom remains banned from the native graph because
  of the Android freeze fixed in #3167.
- Browser preferences use the v3 AsyncStorage `createAsyncStorage` IndexedDB
  implementation. Never persist authentication tokens in that store.
- Platform-split native controls need a `.web.tsx` or shared fallback. Browser
  variants follow the Material visual language.

### Validation sequence

After mobile changes:

1. `vp run typecheck:mobile` — always.
2. `vp run test:mobile` (or `vp test run --project mobile`) — always. Do **not** use `vp test --project mobile run` — the flag-before-`run` order runs ~1 file (false green).
3. `vp run check:mobile-bundle` — Metro bundle check (Linux-safe; highest-value).
4. `vp run check:mobile-simulator` — macOS only; skips on Linux.
5. `vp run mobile:screenshot` — macOS only.

### Mobile performance checklist (PR review)

For any list, provider, gesture, or board-art change, confirm:

- **List virtualized?** `FlashList` / `BottomSheetFlatList`, never `.map()` in a `ScrollView`. Any `loadMore` is one page per end-reach, not a drain-until-`hasMore`.
- **Row memoized & `renderItem` deps clean?** Row is `React.memo`'d; `renderItem` is a `useCallback` whose deps have **no array `.length`** and **no inline closures**; `keyExtractor` hoisted.
- **Provider value memoized & state/actions split?** Context `value` is `useMemo`'d; a volatile array (logbook, reducer state, roster) is not bundled with the stable callbacks consumers depend on. Enforced for `packages/mobile/**` + `packages/shared/**` by `react/jsx-no-constructed-context-values` (error).
- **Per-row hook O(1)?** Reads a pre-built index (`Map`), never `array.filter`/scan per row.
- **Worklet `runOnJS` gated?** No `runOnJS(setState)` per frame — gate on a value change; mirror read JS values into shared values instead of listing them in the gesture `useMemo` deps.
- **New effect bounded?** No unbounded `loadMore` loops or per-frame state churn.

Full rationale + repo examples: `docs/react-native-performance.md`.

### Local iOS builds

Use `vp run mobile:ios` for local `packages/mobile` iOS builds instead of raw `expo run:ios`. The wrapper points generated `packages/mobile/ios/build` at a shared cache under `~/Library/Caches/boardsesh/xcode/packages-mobile-ios/build`, so separate git worktrees reuse the same Xcode build products. Override with `BOARDSESH_IOS_BUILD_CACHE_DIR=/path/to/cache` only when deliberately isolating a cache. Do not pass `--no-build-cache`; it clears iOS derived data and defeats the shared-cache workflow.

### App Store screenshots (cached dev-client + Metro)

`vp run mobile:screenshots` (`scripts/mobile-screenshots.ts`) drives Maestro over iOS simulators. The app it installs is a Debug **dev-client** that loads its JS from **Metro** at runtime — the screenshot behaviour (`EXPO_PUBLIC_SCREENSHOT_MODE`, theme, locale, workout) is baked into the Metro JS bundle, **not** the native binary. So the native `.app` is reusable: only the JS regenerates per run.

- Pass `--app-path <Boardsesh.app>` to install a prebuilt/cached app (CI's common path). Without it, the script builds one via `vp run mobile:build-sim-app` (`scripts/mobile-build-sim-app.ts` → `expo prebuild` + `pod install` + `xcodebuild build -sdk iphonesimulator -configuration Debug`; **not** `expo run:ios`, whose launch step hangs in CI). Use `--clean` for a deterministic from-scratch build.
- The default Apple capture is `--devices common --locales all`: iPhone 16 Pro Max, iPhone 14 Plus, and iPhone 16 Pro for the store-ready app locales `en-US`, `es`, `fr`, and `de`. The Spanish app locale is written to both App Store Connect folders, `es-ES` and `es-MX`; French and German map to `fr-FR` and `de-DE`.
- `.github/workflows/mobile-screenshots-ios.yml` caches the `.app` (`actions/cache`) keyed on **native inputs only**: `packages/mobile/app.config.ts`, `plugins/**`, `modules/**`, `locales/**` (the iOS `InfoPlist.strings` sources), `package.json`, `patches/**`, the root `package.json` (which pins `@expo/cli`), and `pnpm-workspace.yaml` (native overrides and patch mappings), plus `runner.os`/`runner.arch`. JS/TS-only and web-only changes (including `pnpm-lock.yaml` churn) are a cache hit and skip the ~30-min native build; any native-input change busts the key and rebuilds. Bump the `-v1-` salt to force a rebuild. A native-dep change must invalidate the key — when adding native config, confirm it's covered by one of those globs.

### Android emulator screenshots (local, dev-client + Metro)

For quick ad-hoc shots of the live app on an Android emulator (the fast KVM path on Linux/Intel), `vp run mobile:android-shots` (`scripts/mobile-android-shots.ts`) boots an x86*64 emulator, installs a cached **dev-client** APK (`com.boardsesh.app.dev`, universal `arm64-v8a`+`x86_64`), starts Metro, and captures with `adb exec-out screencap`. Same `EXPO_PUBLIC_SCREENSHOT*_`env as iOS; the deep-link scheme is`com.boardsesh.app://`for both variants (only the package differs). The APK comes from the latest`rn-android-dev-_`release (or a local Gradle fallback). One-time setup:`vp run mobile:android-doctor`(bootstraps the SDK + JDK 21 under`~/.cache/boardsesh/`). Full guide: `docs/android-emulator-screenshots.md`. This is distinct from `vp run mobile:screenshots --platform android`, which installs a standalone store APK with bundled JS.

### Native release workflow

- All mobile changes target `main`. JavaScript-only changes ship by OTA while `main` matches an accepted store fingerprint.
- A change that moves the native fingerprint triggers automatic TestFlight and Play-internal builds from `main`. The current store fleet cannot receive OTAs from the new fingerprint until the replacement binary is installed, so keep native release work focused and ship promptly.
- Land the version and localized release notes before the final native change so the automatic builds carry the intended release identity and copy.
- Split mixed backend/native work when useful. Keep the backend compatible with the currently shipped app until the replacement store release has been adopted.
- Urgent fixes for an older accepted fingerprint use the OTA backport workflow and immutable release anchors.

### OTA preview distribution

Two preview paths, by audience:

- **Per-PR self-hosted branches (store / TestFlight binary).** Every PR with RN changes can publish its JS bundle to a `pr-<number>` branch on xprem. Any user on a compatible store/TestFlight build switches through xprem's official blue edge marker. Same-repo PRs auto-publish on every push; fork PRs require a `/ota-preview` comment from a maintainer with repository write access (or `workflow_dispatch`). Each new revision resets the mutable branch first, and a revision with no remaining mobile changes removes it. `EOO_TOKEN` is scoped to the `ota-preview` GitHub environment; fork authorization is enforced by a live repository-permission check. Branches are torn down on PR close via `scripts/ota-preview-cleanup.ts delete --branch pr-N` plus a daily sweep; the helper also removes same-named legacy channels during migration. S3 growth is backstopped by a bucket lifecycle rule scoped to `{appId}/pr-`. Workflow: `.github/workflows/mobile-ota-preview.yml` (sweep: `mobile-ota-preview-sweep.yml`). See `docs/mobile-ota-updates.md`.
- **EAS dev-client preview build (native-change testing).** `vp run mobile:preview-build` produces an installable `.ipa`/`.apk` dev-client; JS updates ride the EAS free tier via `vp run mobile:publish` (defaults to the current git branch; point a channel with `vp dlx eas-cli@16 channel:edit preview-N --branch <branch>`). Use this when a change is **native** — a `pr-<number>` OTA can't reach the store binary across a fingerprint change. This path is no longer auto-published in CI; publish locally. `EXPO_TOKEN` required.

A new preview build is only needed when native deps change (new Expo plugin, new native module, SDK bump). JS/TS changes ride OTA.

### OTA production distribution (self-hosted expo-open-ota V3)

Production/TestFlight builds use our **self-hosted V3 control-plane** server at `updates.boardsesh.com` (`xprem:v3.1.2`, Postgres-backed), not EAS hosting — see `docs/mobile-ota-updates.md`. The old V2 server at `ota.boardsesh.com` was **destroyed on 2026-08-25**; binaries from before the V3 cutover now run their embedded bundle until updated through the store. New/updated binaries bake literal `expo-channel-name: production`, `expo-app-id: 007e6fd7-…`, and empty `xprem-branch` request headers, and point `updates.url` at `updates.boardsesh.com` (`EXPO_UPDATES_URL`). Production OTAs **auto-publish on every push to `main`** via `.github/workflows/mobile-ota-production.yml` (manual: `vp run mobile:publish -- --channel production`; `eoas@3.1.2`, `EXPO_UPDATES_URL` + app-scoped `EOO_TOKEN`). The production channel↔branch mapping is a one-time dashboard action. Per-PR previews use official Branch Surfing with a narrow `pr-*` pattern and no per-PR channel mapping. Keep Branch Surfing off until native builds containing `@xprem/control-center` and the `xprem-branch` header are ready, then enable it on the production channel. V3 also supports progressive rollouts. EAS preview builds keep the separate BranchSwitcher path. One-time infra: `vp run mobile:ota-setup`.

runtimeVersion uses the **`fingerprint`** policy (a hash of the native project), so a JS-only change keeps the same fingerprint and the OTA lands, while any native change yields a new fingerprint that old binaries won't pull (no `appVersion` footgun, no manual `version` bump for OTA compatibility). **Fingerprint parity is the one rule:** the OTA publish must resolve `app.config.ts` to the same config the native build did, so `mobile-ota-production.yml` mirrors the native workflows' env (guarded by `scripts/mobile-ci-env-parity.test.ts`) and publishes per-platform (iOS without `GOOGLE_MAPS_API_KEY`, Android with it — the key perturbs both fingerprints). Resolve a fingerprint with `vp exec expo-updates runtimeversion:resolve --platform ios|android`.
