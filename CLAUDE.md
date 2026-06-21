# CLAUDE.md

Guidance for Claude Code working in this repo.

## Project Overview

Boardsesh is a monorepo. Next.js 16 web app + React Native (Expo) mobile app for controlling Kilter / Tension / MoonBoard climbing boards. Adds queue management and real-time collaborative control on top of Aurora Climbing's software.

## Project Rules

- Backend work belongs in `packages/backend` (GraphQL), not in the Next.js app. We are slowly moving REST/server logic out of `packages/web`.
- Work autonomously end-to-end: backend + frontend + QA. Don't stop at "API is ready but UI isn't updated."
- Use subagents (always Opus) for grunt work. Pair every implementation subagent with a QA/reviewer subagent.
- No AI-generated images. Real photos or diagrams only.
- No buzzwords. Concrete numbers, plain language.
- Default to action. Full autonomy except no data deletion without asking.

## PR Lifecycle (mandatory)

We'll always create a PR, never asks if a PR should be created, open as a draft. After every PR is created, **always** subscribe to PR feedback until the PR is merged or closed.

- **CI failures**: diagnose and push a fix. Retry until green. If a failure is genuinely out of scope, explain and block on the user.
- **Merge conflicts**: rebase on `main` and `git push --force-with-lease` — don't ask first.
- **Review feedback**: fix minor, cosmetic, and style comments autonomously and push. For correctness disagreements, architectural changes, or ambiguous instructions, use `AskUserQuestion` before acting.
- **Release notes**: every PR description must include the `## Release Notes` section from the PR template. Write in climber voice — describe what the user gets, not what the code does. Internal-only changes (refactor, CI, deps, tests) get `none`.
- **Ready to merge signal**: once CI is green, no unresolved review comments remain, and there are no conflicts, remove the draft status from the PR marking it ready for review.

## Monorepo Structure

```
/packages/
  /web/             # Next.js web application
  /mobile/          # React Native (Expo) mobile application
  /backend/         # WebSocket backend for party mode (graphql-ws)
  /shared-schema/   # Shared GraphQL schema and TypeScript types
  /shared/
    /play-view/     # Play-drawer logic (queue nav, tick utils, grade display)
    /queue/         # Queue state machine (reducer, types, event utils)
    /board-config/  # Board metadata, hold maps, angle tables
    /board-constants/ # Grade colours, difficulty bands
    /board-react/   # Renderer-agnostic BoardProvider + logbook/tick hooks (useSaveTick/useUpdateTick/useDeleteTick)
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

Toolchain is [Vite+](https://viteplus.dev) (`vp`). **Never use `bun run`, `bunx`, or `npx` for validation** — they bypass the unified config and can mutate `bun.lock`. The only sanctioned non-`vp` invocations are `bunx drizzle-kit generate` (migrations) and `bun run backend:start` (prod backend).

Use `vp check` or `vp run typecheck` to validate — **not** `vp run build` (build interferes with the dev server). `vp check` runs lint + format (the staged pre-commit hook calls `vp check --fix`). Run `vp run typecheck` before pushing.

Common commands:

- `vp check` — format + lint (canonical validation; pre-commit)
- `vp test` / `vp test run --reporter=agent` — tests (always use `--reporter=agent` to save context)
- `vp test run --project web|backend|mobile` — scope tests. **`--project` MUST come after `run`.** `vp test --project mobile run` (flag before `run`) silently treats the name as a filename filter and runs ~1 file — a false green. Prefer the footgun-proof aliases `vp run test:mobile` / `vp run test:web`.
- `vp run dev` — start DB + backend + web
- `vp run dev:mobile` — start mobile dev server (Metro)
- `vp run db:up` / `vp run db:migrate` / `vp run db:studio`
- `vp run build`, `vp run typecheck` (+ `:web`, `:backend`, `:mobile`, `:db`, `:shared`)
- `vp run check:i18n` — fails on hardcoded English strings under `packages/web/app/`
- `vp run check:mobile-bundle` — headless Metro bundle check (Linux-safe)
- `vp run check:mobile-simulator`, `vp run mobile:screenshot` — macOS only
- `vp run mobile:ios` — local Expo iOS build with the shared Boardsesh Xcode cache
- `vp run mobile:publish` — EAS Update for current branch
- `vp run test:e2e` — Playwright; auto-starts the dev DB + web server

### Database

- `bunx drizzle-kit generate` from `packages/db/` to create migrations. **Never hand-write migration SQL** — it must be in `_journal.json`, which `drizzle-kit generate` updates for you.
- Dev DB is a pre-built image (`ghcr.io/boardsesh/boardsesh-dev-db`) with all board data, a test user (`test@boardsesh.com` / `test`), and seed data. Reset: `docker compose down -v && vp run db:up`.

### Database hosting (Railway)

We host Postgres on Railway but treat it as portable — anything we write should run on a `docker run postgres:17`. No Railway-specific addons, env vars, build steps, or schema mutations via dashboard. `pg_dump`/`pg_restore` must be sufficient to lift-and-shift. Same rule for object storage / video / analytics: prefer S3-compatible APIs, OpenTelemetry exporters, standard connection strings. Exit runbook: `docs/neon-migration.md`.

## GitHub Issue Fix Workflow

When the request references an issue ("fix issue #N", "this GH issue", a bug link):

1. **Work in a fresh git worktree branched off the latest `main`.** Fetch `origin/main` first.
2. **Plan before implementing.**
3. **Pre-commit hook must pass** — fix underlying issues, no `--no-verify`.
4. **Write a QA notes file before starting the dev server.** `.boardsesh/qa-notes.md` is the default path the orchestrator auto-detects and surfaces in-app via `/api/internal/dev-metadata`. Include the specific pages/flows to exercise, expected behaviour, and edge cases. For an alternate path, pass `vp run dev -- --qa-notes-file <path>`. **Never start the dev server for an issue fix without QA notes.**
5. **Start the dev server with `vp run dev`** (web) or `vp run dev:mobile` (mobile). Confirm the startup log shows `[dev] QA notes: <path>`. For mobile, the orchestrator surfaces QA notes in the `DevMetadataPanel` (More tab); Metro output is tee'd to `.boardsesh/mobile-metro.log`.
6. **Tell the user the URL in one message** — whatever the server prints (typically `http://localhost:3000`). Don't paste the QA plan into chat; it's already in the file and the app.
7. **Always open a PR** once validated.

Ad-hoc edits and direct feature requests don't trigger this workflow. If the user opts out of a step, respect that for the current task only.

## Documentation

Read relevant `docs/` before working on the matching area; update docs when the system changes.

- `docs/websocket-implementation.md` — WebSocket party session architecture
- `docs/ai-design-guidelines.md` — Velvet Send design system (mobile-canonical: palette, typography, tokens, Liquid Glass / Material variants; web still on the legacy rose/sage palette, pending migration)
- `docs/live-activity-push-testing.md` — APNs Live Activity push testing
- `docs/logging.md` — backend structured logger (winston)

## Architecture Overview

### Web routing

Deeply nested dynamic routes: `/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/...`. Routes mirror `/api/v1/...`. Board names: `kilter`, `tension`. Next.js App Router — prefer server components wherever possible (queue/realtime components are necessarily client).

### Key components

- **BoardProvider** (`packages/web/app/components/board-provider-context.tsx`) — auth, sessions, logbook, IndexedDB.
- **QueueProvider** (`packages/web/app/components/queue-control/queue-context.tsx`) — climb queue (reducer), search, GraphQL-WS sync.

### Data flow

- Server components fetch initial data.
- Client components use React Query.
- API: `/api/internal/...` for server-side ops; `/api/v1/[board]/proxy/...` for Aurora proxies.
- State: Context + `useReducer` for complex state; URL params as source of truth for board config.

### Integration points

Web Bluetooth (board LEDs), GraphQL-WS backend, Redis (pub/sub for multi-instance), IndexedDB (client persistence), Aurora API (user sync).

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

Supported locales: `en-US` (root), `es` (`/es/*`), `fr`. Path-based detection via middleware (`packages/web/middleware.ts`). Catalogs in `packages/web/i18n/locales/<locale>/<namespace>.json`. Namespaces: `common`, `marketing` (add new ones in `SEED_NAMESPACES` in `app/lib/i18n/config.ts`).

- **Add every new key to every locale.** `i18n-catalog-completeness.test.ts` enforces parity per namespace.
- Server: `const { t } = await getServerTranslation('marketing')`.
- Client: `const { t } = useTranslation('marketing')`.
- Internal links: `<LocaleLink>` from `@/app/components/i18n/locale-link` (not raw `next/link`). MUI: `<MuiLink component={LocaleLink} href="...">`.
- Page metadata: use `createPageMetadata({ title, description, path, locale })` for hreflang alternates.
- Inline formatting with multiple tags: react-i18next `<Trans>` (see `app/legal/legal-content.tsx`).
- Use ICU placeholders: `"greeting": "Hello {{name}}"`.
- **Don't translate** code samples in `<pre>` blocks, brand names (Boardsesh, Kilter, Tension, MoonBoard), or user-generated content.
- Linter hard-fails on `t(variable)` / `t('a' + b)` — use string literals or template literals only.

Adding a new locale: update `SUPPORTED_LOCALES` and friends in `app/lib/i18n/config.ts`, add catalog dir, language switcher, sitemap.

**Spanish terminology:** Spanish translations follow a fixed glossary. Most importantly, a climbing board is **"plafón"** (masculine — _el plafón_, plural _plafones_), never "tabla"/"tablero"/"tabla de escalada" or raw English "board"; fix article/adjective agreement when you swap the word. Brand product names ("Kilter Board", "Tension Board", "MoonBoard") stay as-is. Full terminology, grammar rules, and exceptions: **`docs/i18n-spanish-glossary.md`** — follow it for every Spanish string you add.

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
- Update `packages/web/app/sitemap.ts` when adding a new public page type. Real content timestamps, not `new Date()`.
- Keep trademark wording compatible-not-affiliative.

## Mobile Development (packages/mobile/)

React Native + Expo SDK 56, React Native 0.85, Expo Router 56.

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
- **No web dev-server workflow** — use `vp run dev:mobile` (Metro) instead. The QA-notes-into-`/api/internal/dev-metadata` flow is web-only; on mobile the `DevMetadataPanel` (More tab) reads `.boardsesh/qa-notes.md` via env injection.
- **Styling**: `StyleSheet.create` + theme provider. No MUI, no `style`-prop avoidance rule.
- **Dev mode**: `__DEV__` global, not `process.env.NODE_ENV`.
- **Storage**: `expo-secure-store` for credentials, not IndexedDB.
- **Navigation**: Expo Router, not Next.js App Router.

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
- The default Apple capture is `--devices common --locales all`: iPhone 16 Pro Max, iPhone 14 Plus, and iPhone 16 Pro for app locales `en-US`, `es`, and `fr`. The Spanish app locale is written to both App Store Connect folders, `es-ES` and `es-MX`.
- `.github/workflows/mobile-screenshots-ios.yml` caches the `.app` (`actions/cache`) keyed on **native inputs only**: `packages/mobile/app.config.ts`, `plugins/**`, `modules/**`, `package.json`, `patches/**`, and the root `package.json` (which pins `@expo/cli` / `react-native-screens`), plus `runner.os`/`runner.arch`. JS/TS-only and web-only changes (including `bun.lock` churn) are a cache hit and skip the ~30-min native build; any native-input change busts the key and rebuilds. Bump the `-v1-` salt to force a rebuild. A native-dep change must invalidate the key — when adding native config, confirm it's covered by one of those globs.

### Android emulator screenshots (local, dev-client + Metro)

For quick ad-hoc shots of the live app on an Android emulator (the fast KVM path on Linux/Intel), `vp run mobile:android-shots` (`scripts/mobile-android-shots.ts`) boots an x86*64 emulator, installs a cached **dev-client** APK (`com.boardsesh.app.dev`, universal `arm64-v8a`+`x86_64`), starts Metro, and captures with `adb exec-out screencap`. Same `EXPO_PUBLIC_SCREENSHOT*_`env as iOS; the deep-link scheme is`com.boardsesh.app://`for both variants (only the package differs). The APK comes from the latest`rn-android-dev-_`release (or a local Gradle fallback). One-time setup:`vp run mobile:android-doctor`(bootstraps the SDK + JDK 21 under`~/.cache/boardsesh/`). Full guide: `docs/android-emulator-screenshots.md`. This is distinct from `vp run mobile:screenshots --platform android`, which installs a standalone store APK with bundled JS.

### OTA preview distribution (EAS Update)

Multiple worktrees can publish independent previews. Testers install the "preview" build once and receive JS-only OTA updates.

One-time: `vp run mobile:preview-build` produces an installable `.ipa`/`.apk`. Testers install it (iOS ad-hoc, Android APK).

Four preview channels (`preview-1` ... `preview-4`), one per test device. Publish: `vp run mobile:publish` (defaults to current git branch; pass `--branch`, `--message`, `--platform ios` to override). Point a channel at a branch: `bunx eas-cli@16 channel:edit preview-N --branch <branch>`.

CI: `mobile-eas-update.yml` auto-publishes on every push to a non-main branch touching `packages/mobile/` or shared packages, and comments on the PR. `EXPO_TOKEN` secret required.

A new preview build is only needed when native deps change (new Expo plugin, new native module, SDK bump). JS/TS changes ride OTA.

### OTA production distribution (self-hosted expo-open-ota)

Production/TestFlight builds use **self-hosted** OTA, not EAS hosting — see `docs/mobile-ota-updates.md`. TestFlight/Play builds (bare `expo prebuild`) bake in `EXPO_UPDATES_CHANNEL: production` and point `updates.url` at our expo-open-ota server (`EXPO_UPDATES_URL`). Production OTAs **auto-publish on every push to `main`** via `.github/workflows/mobile-ota-production.yml` (manual: `vp run mobile:publish -- --channel production`; runs `eoas publish`, needs `EXPO_UPDATES_URL` + `EXPO_TOKEN`). Preview builds stay on the EAS free tier (above). One-time infra: `vp run mobile:ota-setup` (run with no arg for the runbook).

runtimeVersion uses the **`fingerprint`** policy (a hash of the native project), so a JS-only change keeps the same fingerprint and the OTA lands, while any native change yields a new fingerprint that old binaries won't pull (no `appVersion` footgun, no manual `version` bump for OTA compatibility). **Fingerprint parity is the one rule:** the OTA publish must resolve `app.config.ts` to the same config the native build did, so `mobile-ota-production.yml` mirrors the native workflows' env (guarded by `scripts/mobile-ci-env-parity.test.ts`) and publishes per-platform (iOS without `GOOGLE_MAPS_API_KEY`, Android with it — the key perturbs both fingerprints). Resolve a fingerprint with `bunx expo-updates runtimeversion:resolve --platform ios|android`.
