import { defineConfig } from 'vite-plus';

const shellQuote = (filePath: string) => `'${filePath.replaceAll("'", "'\\''")}'`;
const isGeneratedFile = (filePath: string) => filePath.includes('/generated/');
// board-controller is a vendored minified bundle — re-formatting it
// in the pre-commit hook produces noisy diffs (Prettier rewraps long
// minified lines) every time someone stages an unrelated file
// elsewhere in the repo and the hook walks the working tree. Match
// the lint + fmt ignore below so the three stay consistent.
const isVendoredBundle = (filePath: string) => filePath.includes('/board-controller/');

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
    // board-controller is a vendored third-party minified bundle —
    // formatting it produces noise diffs every time `vp check --fix`
    // runs without changing what ships, and the linter already ignores
    // the same path. Keep them in lock-step.
    // CHANGELOG.md is generated (and owned/pushed) by the mobile OTA pipeline
    // from PR Release Notes — never hand-format it, or the bot's output and a
    // formatted copy would drift (and the push-to-main `vp check` would flag it).
    // NOTE: files ignored by NAME (e.g. *.generated.json like
    // packages/mobile/src/data/changelog.generated.json) or by nested dir
    // (drizzle/meta/) live in .prettierignore — this `ignore` glob list does not
    // reliably match those forms in `vp check`, but .prettierignore does.
    //
    // Markdown is not formatted at all. The formatter rewrites emphasis spans,
    // and its pairing does not follow CommonMark's intraword-underscore rule:
    // on docs/websocket-implementation.md it paired the `_` inside the bare
    // identifier `NOT_FOUND` with a later `_signed-in_` and emitted
    // `NOT*FOUND` + `\_signed-in*`, silently corrupting an identifier in prose.
    // Reproducible on every run. Prose gains little from auto-formatting and
    // has content the formatter can get wrong, so `.md` is out of scope —
    // mirrored in .prettierignore because a full-repo `vp check` only honours
    // that file for some path forms.
    ignore: ['design/**', '**/generated/**', '**/board-controller/**', 'CHANGELOG.md', '**/*.md'],
  },
  lint: {
    // Keep this list in lock-step with `ignorePatterns` in .oxlintrc.json.
    // `vp check` — the pre-commit hook and CI's only linter — reads THIS block,
    // not .oxlintrc.json (see issue #4548), so the two drifted: main's full-repo
    // pass was type-aware-linting embedded firmware scripts and design/ that
    // .oxlintrc.json excludes and that no PR ever linted. board-controller is a
    // vendored minified bundle; embedded/ is ESP firmware helper scripts;
    // design/, **/generated/** and the drizzle SQL journal are generated or
    // hand-off artefacts nobody edits to satisfy a linter. Matches the fmt
    // ignore list above.
    ignorePatterns: ['**/board-controller/**', 'embedded/**', 'design/**', '**/generated/**', 'packages/db/drizzle/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      // Catch unmemoized React context values (the inline `value={{ ... }}`
      // anti-pattern that re-renders every consumer). Warn repo-wide so the
      // pre-existing web/test violations don't fail CI; promoted to `error` for
      // the mobile + shared-react surfaces below. See docs/react-native-performance.md.
      //
      // NOTE: vite-plus's bundled linter (@oxlint/plugins) does not currently
      // *execute* these two off-by-default `react/*` rules — they show in
      // `vp lint --rules` but never fire — so this is editor/raw-oxlint
      // enforcement + a forward-looking guard, not CI enforcement today. The
      // two mobile providers were fixed by hand to satisfy it.
      'react/jsx-no-constructed-context-values': 'warn',
      // Index keys defeat list reconciliation when rows reorder. Low-noise warn.
      'react/no-array-index-key': 'warn',
    },
    overrides: [
      {
        files: ['packages/mobile/**/*.{ts,tsx}', 'packages/shared/**/*.{ts,tsx}'],
        rules: {
          'react/jsx-no-constructed-context-values': 'error',
          // Hermes ships an incomplete Intl: RelativeTimeFormat and ListFormat
          // are missing on device, so any use crashes mobile release builds
          // while tests pass on Node's full Intl (see the drafts-list crash).
          // Use dayjs relativeTime via @boardsesh/profile-stats instead.
          'no-restricted-properties': [
            'error',
            {
              object: 'Intl',
              property: 'RelativeTimeFormat',
              message:
                'Hermes does not implement Intl.RelativeTimeFormat — crashes mobile release builds. Use dayjs relativeTime via @boardsesh/profile-stats.',
            },
            {
              object: 'Intl',
              property: 'ListFormat',
              message:
                'Hermes does not implement Intl.ListFormat — crashes mobile release builds. Join the parts manually or via i18n.',
            },
            {
              object: 'Linking',
              property: 'openSettings',
              message:
                "Linking.openSettings() does not exist in the Expo web runtime (react-native-web's Linking has no such method) — it throws on app.boardsesh.com. Use openAppSettings() from src/lib/open-app-settings, which Platform-gates and never throws.",
            },
          ],
        },
      },
      {
        files: ['packages/backend/src/**/*.ts'],
        rules: {
          'no-console': 'error',
        },
      },
      {
        files: ['packages/backend/src/__tests__/**/*.ts', 'packages/backend/src/**/*.test.ts'],
        rules: {
          'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
        },
      },
    ],
  },
  test: {
    projects: [
      './packages/web/vite.config.ts',
      './packages/backend/vite.config.ts',
      './packages/moonboard-ocr/vite.config.ts',
      './packages/board-constants/vite.config.ts',
      './packages/aurora-sync/vite.config.ts',
      './packages/kilter-sync/vite.config.ts',
      './packages/location-sync/vite.config.ts',
      './packages/moonboard-sync/vite.config.ts',
      './packages/sync-runtime/vite.config.ts',
      './packages/scheduler/vite.config.ts',
      './packages/crypto/vite.config.ts',
      './packages/shared/ble-protocol/vite.config.ts',
      './packages/shared/board-config/vite.config.ts',
      './packages/shared/board-art-geometry/vite.config.ts',
      './packages/shared/board-render/vite.config.ts',
      './packages/shared/velvet-tokens/vite.config.ts',
      './packages/shared/text-redaction/vite.config.ts',
      './packages/shared/pr-body/vite.config.ts',
      './packages/shared/board-react/vite.config.ts',
      './packages/shared/create-climb-react/vite.config.ts',
      './packages/shared/queue/vite.config.ts',
      './packages/shared/offline-sync/vite.config.ts',
      './packages/shared/logbook/vite.config.ts',
      './packages/shared/queue-runtime/vite.config.ts',
      './packages/shared/board-presence/vite.config.ts',
      './packages/shared/board-presence-react/vite.config.ts',
      './packages/shared/queue-react/vite.config.ts',
      './packages/shared/playlists-react/vite.config.ts',
      './packages/shared/party-profile/vite.config.ts',
      './packages/shared/watch-pairing/vite.config.ts',
      './packages/shared/analytics/vite.config.ts',
      './packages/shared/climb-actions/vite.config.ts',
      './packages/shared/key-value-storage/vite.config.ts',
      './packages/shared/play-view/vite.config.ts',
      './packages/shared/playback-react/vite.config.ts',
      './packages/shared/profile-stats/vite.config.ts',
      './packages/shared/playlist-generator/vite.config.ts',
      './packages/shared/climb-filters/vite.config.ts',
      './packages/shared/gym-claim/vite.config.ts',
      './packages/shared/kiosk/vite.config.ts',
      './packages/shared/i18n/vite.config.ts',
      './packages/shared/graphql/vite.config.ts',
      './packages/shared/graphql-client/vite.config.ts',
      './packages/shared/email/vite.config.ts',
      './packages/shared/static-assets/vite.config.ts',
      './packages/shared-schema/vite.config.ts',
      './packages/mobile/vite.config.ts',
      './scripts/vite.config.ts',
      './deploy/app-subdomain/vite.config.ts',
    ],
  },
  staged: {
    '*.{ts,tsx,js,mjs,cjs}': (stagedFileNames) => {
      const lintableFileNames = stagedFileNames.filter(
        (fileName) => !isGeneratedFile(fileName) && !isVendoredBundle(fileName),
      );
      return lintableFileNames.length > 0 ? `vp check --fix ${lintableFileNames.map(shellQuote).join(' ')}` : [];
    },
    'packages/web/app/**/*.{ts,tsx}': () => ['vp run check:i18n', 'vp run check:i18n:orphans'],
    'packages/mobile/{src,app}/**/*.{ts,tsx}': () => 'vp run check:i18n:orphans',
    'packages/mobile/**/*.{ts,tsx,swift}': () => 'vp run check:mobile-board-art-network',
    'packages/shared/i18n/locales/**/*.json': () => 'vp run check:i18n:orphans',
    // Anything that can change what /api/internal/board-render draws has to move
    // the committed `&v=` constant with it, or Cloudflare keeps serving the old
    // pixels `immutable` for a year (#4773). Broad globs on purpose: the generator
    // derives its inputs from the board catalogue, so a narrow paths list here
    // would be a guard that silently stops guarding.
    '{packages/board-renderer/wasm/pkg/**,packages/shared/board-render/src/**,packages/shared/board-config/src/**,packages/board-constants/src/**,packages/web/public/images/**}':
      () => 'vp run check:board-render-version',
  },
  run: {
    tasks: {
      // --- Database ---
      'db:up': {
        command: 'bash scripts/dev-db-up.sh',
        cache: false,
      },
      'db:migrate': {
        command: 'pnpm --filter @boardsesh/db run db:migrate',
        dependsOn: ['db:up'],
        cache: false,
      },
      // Read-only pre-flight for the VERIFY_MIGRATION_JOURNAL=1 gate that
      // production-deploy.yml runs (#2933): reports any journal migration with
      // no row in drizzle.__drizzle_migrations. One SELECT, no writes, no
      // migrate() call — safe to point at production before a deploy. No db:up
      // dependency: it's normally run by hand against DB_URL, same pattern as
      // db:dedupe-gyms.
      'db:verify-journal': {
        command: 'pnpm --filter @boardsesh/db run db:verify-journal',
        cache: false,
      },
      'db:studio': {
        command: 'pnpm --filter @boardsesh/db run db:studio',
        dependsOn: ['db:up'],
        cache: false,
      },
      // Rebase onto origin/main and move this branch's migration to the next free
      // number, keeping the author's SQL. Run it when main takes your number; CI
      // runs the same task from .github/workflows/db-migration-renumber.yml.
      'db:renumber': {
        command: 'tsx scripts/db-renumber-migration.ts',
        cache: false,
      },
      'db:seed-social': {
        command: 'pnpm --filter @boardsesh/db run db:seed-social',
        dependsOn: ['db:up'],
        cache: false,
      },
      'db:create-test-user': {
        command: 'pnpm --filter @boardsesh/db run db:create-test-user',
        dependsOn: ['db:up'],
        cache: false,
      },
      'db:seed-locations': {
        command: 'true',
        dependsOn: ['locations:aurora', 'locations:kilter', 'locations:moonboard'],
        cache: false,
      },
      'db:dedupe-gyms': {
        command: 'pnpm --filter @boardsesh/db run db:dedupe-gyms',
        // Intentionally no db:up dependency: this maintenance/reporting command
        // often targets DB_URL against a remote database instead of local Docker.
        cache: false,
      },
      'db:dedupe-beta-links': {
        command: 'pnpm --filter @boardsesh/db run db:dedupe-beta-links',
        // No db:up dependency, same rationale as db:dedupe-gyms: a maintainer
        // runs this by hand against DB_URL (often a remote database), not local
        // Docker. Dry-run by default; --apply is the only write path. Forward
        // flags with `vp run db:dedupe-beta-links -- --apply`.
        cache: false,
      },
      'db:refresh-climb-grades': {
        command: 'pnpm --filter @boardsesh/db run db:refresh-climb-grades',
        // No db:up dependency: this often targets a remote DB_URL and supports
        // read-only validation/dry-runs before writing published grade rows.
        cache: false,
      },
      'db:dedupe-serial-boards': {
        command: 'pnpm --filter @boardsesh/db run db:dedupe-serial-boards',
        // No db:up dependency, same rationale as db:dedupe-gyms: a maintainer
        // runs this by hand against DB_URL (often a remote database), not local
        // Docker. Dry-run by default; --apply is the only write path. Forward
        // flags with `vp run db:dedupe-serial-boards -- --only-serial <s> --apply`.
        cache: false,
      },
      'test:db': {
        command: 'pnpm --filter @boardsesh/db run test',
      },
      // The one packages/db node:test file CI runs (from ci.yml's db-migrations
      // job, against its current PostgreSQL service). It builds its own throwaway
      // migrations folder and database, so it needs no board data and no db:up.
      // Locally it skips unless DATABASE_URL/MIGRATION_JOURNAL_DB_URL points at
      // a local Postgres.
      'test:db:migration-journal': {
        command: 'pnpm --filter @boardsesh/db run test:migration-journal',
        cache: false,
      },
      'test:postgres18-contract': {
        command: 'bash scripts/postgres18-contract.sh',
        cache: false,
      },
      'test:postgres16-role-transition': {
        command: 'bash scripts/postgres16-role-transition-smoke.sh',
        cache: false,
      },
      'test:postgres18-image': {
        command: 'bash scripts/postgres18-image-smoke.sh',
        cache: false,
      },
      'test:postgres18-architecture-image': {
        command: 'bash scripts/postgres18-architecture-smoke.sh',
        cache: false,
      },
      // Boots the exact image production runs (postgis/postgis:16-master,
      // PostGIS 3.7.0dev) beside the pinned PG18/3.6.4 artifact and copies the
      // application's whole spatial surface between them. Needs docker and
      // several minutes; it is the evidence behind the PostGIS blocker, not a
      // per-PR gate.
      'test:postgres18-spatial-rehearsal': {
        command: 'bash scripts/postgres18-spatial-rehearsal.sh',
        cache: false,
      },
      'test:postgres18-dev-db-image': {
        command: 'bash scripts/dev-db-image-smoke.sh',
        cache: false,
      },
      'locations:aurora': {
        command: 'pnpm --filter @boardsesh/aurora-sync run sync:locations',
        dependsOn: ['db:up'],
        cache: false,
      },
      'locations:kilter': {
        command: 'pnpm --filter @boardsesh/kilter-sync run sync:locations',
        dependsOn: ['db:up'],
        cache: false,
      },
      'locations:moonboard': {
        command: 'pnpm --filter @boardsesh/moonboard-sync run sync:locations',
        dependsOn: ['db:up'],
        cache: false,
      },
      // Runs the cron scheduler against a local web server. Needs CRON_SECRET
      // and (usually) BOARDSESH_WEB_URL=http://localhost:3000 in the env.
      'scheduler:dev': {
        command: 'pnpm --filter @boardsesh/scheduler run dev',
        cache: false,
      },
      'seed:beta-links': {
        command: 'pnpm --filter @boardsesh/db run db:seed-beta-links',
        dependsOn: ['db:up'],
        cache: false,
      },
      'db:import-moonboard': {
        command: 'pnpm --filter @boardsesh/db run db:import-moonboard',
        dependsOn: ['db:up'],
        cache: false,
      },
      // Imports the full Woods Board catalog (5,400+ climbs) from a local
      // checkout of boardsesh/woodsboard-scraper. Point it at the catalog dir
      // with `vp run db:import-woods-catalog -- /path/to/catalog` (or set
      // WOODS_CATALOG_DIR). No db:up dependency: the prod import targets a
      // remote DB_URL, and the in-script guard (woods-import-guard.ts) is what
      // gates a non-local host — it refuses unless WOODS_IMPORT_ALLOW_REMOTE=1.
      // Booting local Docker first would only get in the way of that run.
      'db:import-woods-catalog': {
        command: 'pnpm --filter @boardsesh/db run db:import-woods-catalog',
        cache: false,
      },
      // Regenerates the committed MoonBoard cell->set map from the per-set board
      // art. No DB needed (reads images, writes a TS file). Pass `-- --check` for
      // a drift check that fails instead of writing.
      'db:generate-moonboard-cell-sets': {
        command:
          'pnpm --filter @boardsesh/db run db:generate-moonboard-cell-sets && vp fmt packages/shared/board-config/src/generated/moonboard-cell-sets.ts',
        cache: false,
      },
      // Writes the `hold_outline_overrides` rows out to the committed JSON files
      // `generate:board-art-geometry` merges into the shards. Reads a database,
      // so it is run by hand by whoever corrected the outline — then
      // `vp run generate:board-art-geometry`, then commit both. The shard drift
      // gate (`vp run check:board-art-geometry`) is what enforces the pair; this
      // task has no check mode of its own.
      'db:export-outline-overrides': {
        command:
          'bun run --filter=@boardsesh/db db:export-outline-overrides && vp fmt packages/shared/board-art-geometry/overrides',
        cache: false,
      },
      // Recomputes required_set_ids for every MoonBoard climb from its frames +
      // the cell->set map. No db:up dependency: run by hand against DB_URL (prod)
      // or after db:up locally, same pattern as db:dedupe-gyms.
      'db:backfill-moonboard-set-ids': {
        command: 'pnpm --filter @boardsesh/db run db:backfill-moonboard-set-ids',
        cache: false,
      },
      // Seeds the relational MoonBoard product/layout/set/hole/placement catalog.
      // Dry-run by default; pass `-- --apply` for the locked, validated write path.
      'db:backfill-moonboard-hardware': {
        command: 'pnpm --filter @boardsesh/db run db:backfill-moonboard-hardware',
        cache: false,
      },
      // Repairs only existing catalog-backed MoonBoard 8C/8C+ rows whose grade
      // columns are still NULL. Requires the full app catalog as input, reports
      // only by default, and writes only with an explicit `--apply`.
      'db:repair-moonboard-8c-grades': {
        command: 'pnpm --filter @boardsesh/db run db:repair-moonboard-8c-grades',
        cache: false,
      },
      // Repairs ticks whose attempt count was floored to 2 by the mobile
      // quick-tick clamp (#3937). Needs `-- --events <posthog-export>`; add
      // `--dry-run` to report without writing, `--revert <snapshot>` to undo.
      // Run by hand against DB_URL with UPDATE rights, same pattern as
      // db:dedupe-gyms.
      'db:backfill-clamped-send-attempts': {
        command: 'pnpm --filter @boardsesh/db run db:backfill-clamped-send-attempts',
        cache: false,
      },

      // --- Codegen (GraphQL types for client + backend resolvers) ---
      // Direct workspace-binary invocation; no remote package runner.
      // print-schema concatenates the modular gql typeDefs into a single SDL
      // file that graphql-codegen reads as its schema input.
      codegen: {
        command:
          'tsx packages/shared-schema/scripts/print-schema.ts && graphql-codegen && vp fmt packages/shared-schema/src/generated/ packages/shared/graphql/src/generated/',
        input: [
          'codegen.ts',
          'packages/shared-schema/scripts/print-schema.ts',
          'packages/shared-schema/src/schema/**/*.ts',
          'packages/shared-schema/src/types/**/*.ts',
          'packages/shared/graphql/src/**/*.ts',
          '!packages/shared/graphql/src/generated/**',
          'packages/web/app/**/*.{ts,tsx}',
          '!packages/web/app/lib/graphql/**',
          '!packages/web/**/*.test.{ts,tsx}',
        ],
      },

      // --- Build (topological order via dependsOn) ---
      'build:shared': {
        command: 'pnpm --filter @boardsesh/shared-schema run build',
        dependsOn: ['codegen'],
      },
      'build:crypto': {
        command: 'pnpm --filter @boardsesh/crypto run build',
      },
      'build:constants': {
        command: 'pnpm --filter @boardsesh/board-constants run build',
        dependsOn: ['build:shared'],
      },
      'generate:board-constants': {
        command: 'pnpm --filter @boardsesh/board-constants run generate',
        cache: false,
      },
      'build:db': {
        command: 'pnpm --filter @boardsesh/db run build',
        dependsOn: ['build:shared'],
      },
      'build:sync-runtime': {
        command: 'pnpm --filter @boardsesh/sync-runtime run build',
      },
      'build:scheduler': {
        command: 'pnpm --filter @boardsesh/scheduler run build',
      },
      'build:location-sync': {
        command: 'pnpm --filter @boardsesh/location-sync run build',
        dependsOn: ['build:shared', 'build:constants', 'build:db'],
      },
      'build:moonboard-sync': {
        command: 'pnpm --filter @boardsesh/moonboard-sync run build',
        dependsOn: ['build:db', 'build:location-sync'],
      },
      'build:aurora': {
        command: 'pnpm --filter @boardsesh/aurora-sync run build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:location-sync', 'build:sync-runtime'],
      },
      'build:kilter': {
        command: 'pnpm --filter @boardsesh/kilter-sync run build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:location-sync', 'build:sync-runtime'],
      },
      'build:backend': {
        command: 'pnpm --filter boardsesh-backend run build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:constants', 'build:aurora', 'build:kilter'],
      },
      'build:web': {
        command: 'pnpm --filter @boardsesh/web run build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:constants'],
        // Forwarded into the task (vp runs tasks with a filtered environment)
        // and part of the cache key. Since W-24 (#4438) BOARDSESH_WEB no longer
        // bakes any /app rewrite into a production build — next.config.mjs gates
        // the static fallback on NODE_ENV=development — but the flag is still
        // read at request time (the Expo auth bridge in app/layout.tsx, the
        // middleware /app carve-out), so keep it in the key.
        env: ['BOARDSESH_WEB'],
      },
      'build:expo-web': {
        // Static Expo web export into packages/web/public/app (gitignored) —
        // a LOCAL/dev artifact since W-24 (#4438) retired the /app static path.
        // It backs `dev:mobile:web-static` and the CI bundle check; production
        // publishes the `--subdomain` (baseUrl /) export to app.boardsesh.com.
        // Pass `-- <output-dir>` for a different target (the script strips vp's
        // forwarded `--`).
        command: 'bash scripts/build-expo-web-export.sh',
        dependsOn: ['mobile:web-runtime:install'],
        cache: false,
      },
      'verify:graphql-treeshake': {
        command: 'tsx packages/web/scripts/verify-graphql-treeshake.ts',
        dependsOn: ['build:web'],
        cache: false,
      },
      // Guards the migration folder against the failures that are invisible in
      // review and silent at deploy time: a .sql with no journal entry (never
      // runs), a journal entry with no .sql (crashes the migrator), a duplicate
      // number, and a `when` that isn't newer than main's (skipped forever).
      'check:db-migrations': {
        command: 'tsx scripts/check-db-migrations.ts',
        cache: false,
      },
      'check:i18n': {
        command: 'tsx packages/web/scripts/check-untranslated-strings.ts',
        cache: false,
      },
      // Two-way i18n guard: catalog keys with no reference, code references with
      // no catalog key (#4416), and mobile files reading an unbundled namespace.
      'check:i18n:orphans': {
        command: 'tsx packages/web/scripts/check-orphaned-i18n-keys.ts',
        cache: false,
      },
      'check:mobile-board-art-network': {
        command: 'tsx scripts/mobile-board-art-network-check.ts',
        cache: false,
      },
      'generate:static-assets': {
        command: 'tsx scripts/generate-static-assets.ts',
        cache: false,
      },
      'check:static-assets': {
        command: 'tsx scripts/generate-static-assets.ts --check',
        cache: false,
      },
      'upload:static-assets': {
        command: 'tsx scripts/upload-static-assets.ts',
        cache: false,
      },
      'generate:acknowledgements': {
        command: 'node --import tsx scripts/fetch-acknowledgements.ts',
        cache: false,
      },
      'generate:dark-board-art': {
        command: 'node --import tsx scripts/generate-dark-board-art.ts',
        cache: false,
      },
      // Traced hold silhouettes, per-hold art lightness and painted-LED offsets
      // for every board in the catalogue (#2202). Committed because nothing at
      // runtime can decode the board art; `check:` is the drift gate. ~110s for
      // the whole catalogue, so it is a CI job rather than a pre-commit hook.
      'generate:board-art-geometry': {
        command: 'node --import tsx scripts/generate-board-art-geometry.ts',
        cache: false,
      },
      'check:board-art-geometry': {
        command: 'node --import tsx scripts/generate-board-art-geometry.ts --check',
        cache: false,
      },
      'generate:woods-dark-art': {
        command: 'node --import tsx scripts/generate-woods-dark-art.ts',
        cache: false,
      },
      'generate:oss-licenses': {
        command: 'node --import tsx scripts/generate-oss-licenses.ts',
        cache: false,
      },
      'generate:changelog': {
        command: 'node --import tsx scripts/generate-changelog.ts',
        cache: false,
      },
      // The `&v=` cache version in every /api/internal/board-render URL. Committed
      // (not computed at build time) because the value has to be byte-identical in
      // web's client bundle, the RSC graph and the Node route handler — see the
      // header comment in the generator. `check:` is the drift gate.
      'generate:board-render-version': {
        command: 'node --import tsx scripts/generate-board-render-version.ts',
        cache: false,
      },
      'check:board-render-version': {
        command: 'node --import tsx scripts/generate-board-render-version.ts --check',
        cache: false,
      },
      'check:changelog': {
        command: 'node --import tsx scripts/generate-changelog.ts --check',
        cache: false,
      },
      'changelog:discord-summary': {
        command: 'node --import tsx scripts/changelog-discord-summary.ts',
        cache: false,
      },
      'cleanup:branches': {
        command: 'node --import tsx scripts/cleanup-merged-branches.ts',
        cache: false,
      },
      'check:commit-message': {
        command: 'tsx scripts/check-commit-message.ts',
        cache: false,
      },
      'check:release-notes': {
        command: 'tsx scripts/check-release-notes.ts',
        cache: false,
      },
      'check:pr-test-plan': {
        command: 'tsx scripts/check-pr-test-plan.ts',
        cache: false,
      },
      'test:large-files': {
        command: 'node --test scripts/check-large-files.test.mjs',
        cache: false,
      },
      'check:large-files': {
        command: 'node scripts/check-large-files.mjs',
        dependsOn: ['test:large-files'],
        cache: false,
      },
      'docker-context:backend': {
        command: 'node scripts/create-service-docker-context.mjs backend',
        cache: false,
      },
      'docker-context:web': {
        command: 'node scripts/create-service-docker-context.mjs web',
        cache: false,
      },
      'docker-context:sync': {
        command: 'node scripts/create-service-docker-context.mjs sync',
        cache: false,
      },
      'test:service-deploy-inputs': {
        command:
          'node --test scripts/check-service-deploy-inputs.test.mjs scripts/production-backend-smoke.test.mjs scripts/production-deploy-changes.test.mjs scripts/production-deploy-watchdog.test.mjs scripts/production-web-deploy-targets.test.mjs scripts/railway-deployment-status.test.mjs',
        cache: false,
      },
      'check:service-deploy-inputs': {
        command: 'node scripts/check-service-deploy-inputs.mjs',
        dependsOn: ['test:service-deploy-inputs'],
        cache: false,
      },
      build: {
        command: 'true',
        dependsOn: ['build:backend', 'build:web', 'build:moonboard-sync'],
      },

      // --- Typecheck (depends on build for type declarations) ---
      // Repo-root scripts/ had no typecheck at all, so type errors there only
      // surfaced when a scheduled workflow failed at runtime. Scoped to the
      // Discord feedback pipeline via scripts/tsconfig.json; widen its
      // `include` as other scripts are made type-clean.
      // typescript is a ROOT devDependency for this. Making scripts/ a workspace
      // package to scope it instead does not work: the service Docker contexts
      // copy workspace manifests from packages/ only, so a workspace outside it
      // fails check:service-deploy-inputs and would need all three Dockerfiles
      // changed to ship build tooling into production images.
      'typecheck:scripts': {
        command: 'tsc -p scripts/tsconfig.json',
      },
      'typecheck:shared': {
        command: 'pnpm --filter @boardsesh/shared-schema run typecheck',
        dependsOn: ['build:shared'],
      },
      'typecheck:db': {
        command: 'pnpm --filter @boardsesh/db run typecheck',
        dependsOn: ['build:db'],
      },
      'typecheck:backend': {
        command: 'pnpm --filter boardsesh-backend run typecheck',
        dependsOn: ['build:backend'],
      },
      'typecheck:web': {
        command: 'pnpm --filter @boardsesh/web run typecheck',
        dependsOn: ['build:web'],
      },
      'typecheck:ble-protocol': {
        command: 'pnpm --filter @boardsesh/ble-protocol run typecheck',
      },
      'typecheck:queue': {
        command: 'pnpm --filter @boardsesh/queue run typecheck',
      },
      'typecheck:queue-runtime': {
        command: 'pnpm --filter @boardsesh/queue-runtime run typecheck',
      },
      'typecheck:offline-sync': {
        command: 'pnpm --filter @boardsesh/offline-sync run typecheck',
      },
      'typecheck:queue-react': {
        command: 'pnpm --filter @boardsesh/queue-react run typecheck',
      },
      'typecheck:board-presence': {
        command: 'pnpm --filter @boardsesh/board-presence run typecheck',
        dependsOn: ['build:shared'],
      },
      'typecheck:board-presence-react': {
        command: 'pnpm --filter @boardsesh/board-presence-react run typecheck',
        dependsOn: ['build:shared'],
      },
      'typecheck:playlists-react': {
        command: 'pnpm --filter @boardsesh/playlists-react run typecheck',
      },
      'typecheck:board-react': {
        command: 'pnpm --filter @boardsesh/board-react run typecheck',
      },
      'typecheck:create-climb-react': {
        command: 'pnpm --filter @boardsesh/create-climb-react run typecheck',
      },
      'typecheck:party-profile': {
        command: 'pnpm --filter @boardsesh/party-profile run typecheck',
      },
      'typecheck:watch-pairing': {
        command: 'pnpm --filter @boardsesh/watch-pairing run typecheck',
      },
      'typecheck:analytics': {
        command: 'pnpm --filter @boardsesh/analytics run typecheck',
      },
      'typecheck:pr-body': {
        command: 'pnpm --filter @boardsesh/pr-body run typecheck',
      },
      'typecheck:static-assets': {
        command: 'pnpm --filter @boardsesh/static-assets run typecheck',
      },
      'typecheck:climb-actions': {
        command: 'pnpm --filter @boardsesh/climb-actions run typecheck',
      },
      'typecheck:key-value-storage': {
        command: 'pnpm --filter @boardsesh/key-value-storage run typecheck',
      },
      'typecheck:board-config': {
        command: 'pnpm --filter @boardsesh/board-config run typecheck',
      },
      'typecheck:board-render': {
        command: 'pnpm --filter @boardsesh/board-render run typecheck',
        dependsOn: ['build:constants'],
      },
      'typecheck:board-art-geometry': {
        command: 'pnpm --filter @boardsesh/board-art-geometry run typecheck',
        dependsOn: ['build:constants'],
      },
      'typecheck:play-view': {
        command: 'pnpm --filter @boardsesh/play-view run typecheck',
      },
      'typecheck:playback-react': {
        command: 'pnpm --filter @boardsesh/playback-react run typecheck',
        dependsOn: ['build:constants'],
      },
      'typecheck:profile-stats': {
        command: 'pnpm --filter @boardsesh/profile-stats run typecheck',
        dependsOn: ['build:constants'],
      },
      'typecheck:playlist-generator': {
        command: 'pnpm --filter @boardsesh/playlist-generator run typecheck',
      },
      'typecheck:climb-filters': {
        command: 'pnpm --filter @boardsesh/climb-filters run typecheck',
        dependsOn: ['codegen'],
      },
      'typecheck:kiosk': {
        command: 'pnpm --filter @boardsesh/kiosk run typecheck',
      },
      'typecheck:i18n': {
        command: 'pnpm --filter @boardsesh/i18n run typecheck',
      },
      'typecheck:email': {
        command: 'pnpm --filter @boardsesh/email run typecheck',
      },
      'typecheck:graphql': {
        command: 'pnpm --filter @boardsesh/graphql run typecheck',
        dependsOn: ['codegen'],
      },
      'typecheck:graphql-client': {
        command: 'pnpm --filter @boardsesh/graphql-client run typecheck',
      },
      'typecheck:mobile': {
        command: 'pnpm --filter @boardsesh/mobile run typecheck',
        dependsOn: ['build:shared', 'build:constants', 'mobile:web-runtime:install'],
      },
      'typecheck:kilter': {
        command: 'pnpm --filter @boardsesh/kilter-sync run typecheck',
        dependsOn: ['build:kilter'],
      },
      'typecheck:aurora': {
        command: 'pnpm --filter @boardsesh/aurora-sync run typecheck',
        dependsOn: ['build:aurora'],
      },
      'typecheck:location-sync': {
        command: 'pnpm --filter @boardsesh/location-sync run typecheck',
        dependsOn: ['build:location-sync'],
      },
      'typecheck:moonboard-sync': {
        command: 'pnpm --filter @boardsesh/moonboard-sync run typecheck',
        dependsOn: ['build:moonboard-sync'],
      },
      'typecheck:sync-runtime': {
        command: 'pnpm --filter @boardsesh/sync-runtime run typecheck',
        dependsOn: ['build:sync-runtime'],
      },
      // The eight `build:*` entries in this list stand in for the `typecheck:*`
      // tasks of the same packages (shared-schema, db, backend, aurora-sync,
      // kilter-sync, location-sync, moonboard-sync, sync-runtime). Each of them
      // runs plain `tsc` for `build` and `tsc --noEmit` for `typecheck` against
      // the SAME tsconfig.json — same `include: ["src/**/*"]`, which covers
      // their test files too — and every `typecheck:X` already dependsOn
      // `build:X`. Listing both compiled each package twice back to back: 51
      // CPU-seconds of literal duplicate work per CI run, with
      // `typecheck:backend` the task that ended the non-web half of the job.
      // No coverage is lost: emit-mode `tsc` reports a superset of `--noEmit`
      // diagnostics over the same files (it adds declaration-emit errors).
      //
      // THE INVARIANT THIS BUYS INTO, which is invisible from this file: it
      // holds only while those eight packages' `build` script stays plain `tsc`
      // over the same tsconfig their `typecheck` script uses. The day one of
      // them gains a `tsconfig.build.json` that excludes tests, or switches
      // `build` to a bundler (tsup/esbuild/`bun build`), this aggregate
      // silently stops type-checking it — nothing goes red, coverage just
      // evaporates. Put that package's `typecheck:X` back in this list in the
      // same commit. The `typecheck:X` task definitions above are deliberately
      // kept so `vp run typecheck:backend` still works on its own locally.
      //
      // All eight `build:*` are named here even though build:aurora,
      // build:kilter, build:location-sync and build:sync-runtime arrive
      // transitively via build:backend today, and build:shared/build:db via
      // build:web: spelling them out means an unrelated edit to someone else's
      // dependsOn cannot quietly drop one of them out of the typecheck graph.
      // `scheduler` follows the same plain-`tsc` build/typecheck pattern, so the
      // aggregate `typecheck` task below depends on `build:scheduler` rather
      // than this standalone task (kept for `vp run typecheck:scheduler`).
      'typecheck:scheduler': {
        command: 'pnpm --filter @boardsesh/scheduler run typecheck',
        dependsOn: ['build:scheduler'],
      },
      typecheck: {
        command: 'true',
        dependsOn: [
          'typecheck:scripts',
          'typecheck:pr-body',
          'build:shared',
          'build:db',
          'build:backend',
          'typecheck:web',
          'typecheck:ble-protocol',
          'typecheck:queue',
          'typecheck:queue-runtime',
          'typecheck:offline-sync',
          'typecheck:queue-react',
          'typecheck:board-presence',
          'typecheck:board-presence-react',
          'typecheck:playlists-react',
          'typecheck:board-react',
          'typecheck:create-climb-react',
          'typecheck:party-profile',
          'typecheck:watch-pairing',
          'typecheck:analytics',
          'typecheck:climb-actions',
          'typecheck:key-value-storage',
          'typecheck:board-config',
          'typecheck:board-render',
          'typecheck:board-art-geometry',
          'typecheck:play-view',
          'typecheck:playback-react',
          'typecheck:profile-stats',
          'typecheck:playlist-generator',
          'typecheck:climb-filters',
          'typecheck:kiosk',
          'typecheck:i18n',
          'typecheck:email',
          'typecheck:graphql',
          'typecheck:graphql-client',
          'typecheck:mobile',
          'build:kilter',
          'build:aurora',
          'build:location-sync',
          'build:moonboard-sync',
          'build:sync-runtime',
          'build:scheduler',
        ],
      },
      // Footgun-proof scoped test runs. `vp test --project <name> run` (the
      // `--project` flag BEFORE the `run` subcommand) silently treats the name
      // as a filename filter and runs ~1 file — a false green. These aliases
      // wrap the correct `vp test run --project <name>` form so the order can't
      // be got wrong. cache:false so tests always re-run.
      'test:mobile': {
        command: 'vp test run --project mobile',
        cache: false,
      },
      'test:web': {
        command: 'vp test run --project web',
        cache: false,
      },
      // The offline-sync engine suites live in their own Vitest project
      // (packages/shared/offline-sync/vite.config.ts, name: 'offline-sync').
      // Neither `test:mobile` nor the backend project pulls them in, so a
      // snapshot-bootstrap change validated with only those two runs is a false
      // green — hence its own alias next to the others.
      'test:offline-sync': {
        command: 'vp test run --project offline-sync',
        cache: false,
      },

      // --- Mobile validation ---
      'mobile:web-runtime:install': {
        command: 'pnpm --dir packages/mobile/web-runtime install --frozen-lockfile',
        cache: false,
      },
      'check:mobile-native-deps': {
        command: 'tsx scripts/mobile-native-deps-check.ts',
        cache: false,
      },
      'check:mobile-expo-deps-pinned': {
        command: 'tsx scripts/mobile-expo-deps-pinned-check.ts',
        cache: false,
      },
      'check:mobile-deps': {
        command: 'tsx scripts/mobile-deps-check.ts',
        cache: false,
      },
      'check:mobile-ota-compat': {
        command: 'tsx scripts/mobile-ota-compat-check.ts',
        cache: false,
      },
      'check:mobile-fingerprint-inputs': {
        command: 'tsx scripts/mobile-fingerprint-inputs-check.ts',
        cache: false,
      },
      'check:mobile-patches': {
        command: 'tsx scripts/mobile-patches-check.ts',
        cache: false,
      },
      'check:mobile-variants': {
        // Guards against raw theme-variant magic-string compares regrowing in
        // mobile components — they must route through selectByVariant /
        // createVariantComponent / a theme.* token (see theme/variants/README.md).
        command: 'bash scripts/mobile-variant-guard.sh',
        cache: false,
      },
      'check:mobile-platform-imports': {
        // Guards @expo/ui platform-specific imports to their platform file:
        // @expo/ui/swift-ui only in *.ios.{ts,tsx}, @expo/ui/jetpack-compose only
        // in *.android.{ts,tsx}. A misplaced import crashes the other platform at
        // runtime ("Unable to get view config"). The .oxlintrc.json rule isn't
        // enforced by `vp check` (reduced ruleset), so this is the real backstop.
        command: 'bash scripts/mobile-platform-imports-check.sh',
        cache: false,
      },
      'check:mobile-offline-sync-imports': {
        // Guards the offline-sync adapter boundary: the engine's drain/scheduler/
        // pull entry points must be imported via src/offline/offline-sync-adapter
        // (which binds the connectivity probe + platform triggers), never from
        // '@boardsesh/offline-sync' directly. Like the platform-imports guard,
        // the .oxlintrc.json rule isn't enforced by `vp check`, so this is the
        // real backstop.
        command: 'bash scripts/mobile-offline-sync-imports-check.sh',
        cache: false,
      },
      'check:mobile-bundle': {
        command: 'bash scripts/mobile-bundle-check.sh',
        cache: false,
      },
      'check:mobile-web-bundle': {
        command: 'bash scripts/mobile-web-bundle-check.sh',
        dependsOn: ['mobile:web-runtime:install'],
        cache: false,
      },
      'check:mobile-simulator': {
        command: 'bash scripts/mobile-simulator-check.sh',
        cache: false,
      },
      'mobile:ios': {
        command: 'tsx scripts/mobile-ios-run.ts',
        cache: false,
      },
      'mobile:screenshot': {
        command: 'bash scripts/mobile-screenshot.sh',
        cache: false,
      },
      'mobile:screenshots': {
        command: 'tsx scripts/mobile-screenshots.ts',
        cache: false,
      },
      'mobile:build-sim-app': {
        command: 'tsx scripts/mobile-build-sim-app.ts',
        cache: false,
      },
      'mobile:android-shots': {
        command: 'tsx scripts/mobile-android-shots.ts',
        cache: false,
      },
      'mobile:ios-shots': {
        command: 'tsx scripts/mobile-ios-shots.ts',
        cache: false,
      },
      'mobile:android-doctor': {
        command: 'tsx scripts/mobile-android-doctor.ts',
        cache: false,
      },
      'mobile:android-apk': {
        command: 'tsx scripts/mobile-android-apk.ts',
        cache: false,
      },
      'check:screenshot-dimensions': {
        command: 'tsx scripts/assert-screenshot-dimensions.ts',
        cache: false,
      },
      'mobile:publish': {
        command: 'tsx scripts/mobile-publish.ts',
        cache: false,
      },
      'mobile:upload-sourcemaps': {
        command: 'tsx scripts/mobile-upload-sourcemaps.ts',
        cache: false,
      },
      'mobile:upload-dsyms': {
        command: 'tsx scripts/mobile-upload-dsyms.ts',
        cache: false,
      },
      // Reads the BUILT app, not the manifests: asserts every embedded framework
      // exports the symbols its siblings bind against. Needs a .app argument and
      // macOS `nm`, so it lives here rather than in the check:mobile-* wall that
      // `vp check` runs on Linux. See scripts/mobile-framework-abi-check.ts.
      'mobile:abi-check': {
        command: 'tsx scripts/mobile-framework-abi-check.ts',
        cache: false,
      },
      'mobile:ota-setup': {
        command: 'tsx scripts/mobile-ota-setup.ts',
        cache: false,
      },
      'mobile:ota-health-check': {
        command: 'tsx scripts/mobile-ota-health-check.ts',
        cache: false,
      },
      'mobile:ota-rollback': {
        command: 'tsx scripts/mobile-ota-rollback.ts',
        cache: false,
      },
      'mobile:preview-build': {
        command: 'tsx scripts/mobile-preview-build.ts',
        cache: false,
      },
      'mobile:dev-client-build': {
        command: 'tsx scripts/mobile-dev-client-build.ts',
        cache: false,
      },
      'mobile:make-dev-icons': {
        command: 'tsx scripts/mobile-make-dev-icons.ts',
        cache: false,
      },
      'mobile:onboarding-assets': {
        command: 'tsx scripts/mobile-onboarding-assets.ts',
        cache: false,
      },
      'testflight:feedback-issues': {
        command: 'tsx scripts/testflight-feedback-to-issues.ts',
        cache: false,
      },
      'discord:feedback-scan': {
        command: 'tsx scripts/discord-feedback-scan.ts',
        cache: false,
      },
      // Cloudflare config-as-code for the boardsesh.com zone (DNS proxied flag,
      // the edge-cache rules and the WAF crawler rules). Dry-run by default;
      // forward `-- --apply` (and optionally `--allow-zone-ssl`) to converge.
      // See scripts/cloudflare-apply.ts + docs/cloudflare.md.
      'cf:apply': {
        command: 'tsx scripts/cloudflare-apply.ts',
        cache: false,
      },

      // Railway config-as-code for the OTA project (service + variable assertions
      // and the ClickHouse retention check). Dry-run by default and exits non-zero
      // on drift; forward `-- --apply` to converge what it can.
      // See scripts/railway-apply.ts + docs/railway.md.
      'railway:apply': {
        command: 'tsx scripts/railway-apply.ts',
        cache: false,
      },

      // --- Dev servers ---
      'dev:mobile': {
        command: 'tsx scripts/mobile-dev-start.ts',
        cache: false,
      },
      'dev:mobile:web': {
        command: 'tsx scripts/dev-orchestrator.ts --expo-web',
        dependsOn: ['db:up', 'mobile:web-runtime:install'],
        cache: false,
      },
      // Static-export variant of dev:mobile:web: bakes the export with the
      // Tailscale origin inlined and serves it at /app — robust on loaded
      // machines (no Metro cold-bundle race) and prod-parity, at the cost of
      // fast refresh for mobile code (re-run to pick up mobile changes).
      'dev:mobile:web-static': {
        command: 'bash scripts/dev-expo-web-static.sh',
        dependsOn: ['db:up'],
        cache: false,
      },
      'dev:backend': {
        command: 'pnpm --filter boardsesh-backend run dev',
        dependsOn: ['db:up'],
        cache: false,
      },
      'dev:web': {
        command: 'pnpm --filter @boardsesh/web run dev',
        dependsOn: ['db:up'],
        cache: false,
      },
      dev: {
        command: 'tsx scripts/dev-orchestrator.ts',
        dependsOn: ['db:up'],
        cache: false,
      },

      // --- E2E testing ---
      'test:e2e': {
        command: 'TEST_USER_EMAIL=test@boardsesh.com TEST_USER_PASSWORD=test pnpm --filter @boardsesh/web run test:e2e',
        dependsOn: ['db:up'],
        cache: false,
      },
      'test:e2e:setup': {
        command: 'true',
        dependsOn: ['db:up'],
        cache: false,
      },
      // Expo-web smoke: boots the full expo-web stack (backend + Next proxy +
      // Metro web) via the dev orchestrator and runs the `expo-web-smoke`
      // Playwright project against it. See scripts/expo-web-e2e.ts.
      'test:e2e:expo-web': {
        command: 'tsx scripts/expo-web-e2e.ts',
        dependsOn: ['db:up', 'mobile:web-runtime:install'],
        cache: false,
      },

      // --- Post-deploy production smokes ---
      // Read-only reachability checks against a deployed host. Run by
      // production-deploy.yml after each deploy; safe to run by hand against
      // production or a preview (`vp run smoke:production -- --base https://…`).
      // Never cached — the point is to observe the live deploy, not to memoise
      // an answer from the last one.
      'smoke:production': {
        command: 'tsx scripts/production-smoke.ts',
        cache: false,
      },
      // Browser boot check for app.boardsesh.com — proves the bundle evaluates
      // and React mounts, which the curl smoke in production-deploy.yml cannot
      // see. Uses its own Playwright config (no globalSetup, no webServer) so
      // it can never seed or sign in against a production host.
      // To point this at a preview instead, run playwright directly with
      // PLAYWRIGHT_TEST_BASE_URL set — the config requires it and says so.
      'smoke:app-boot': {
        command:
          'cd packages/web && PLAYWRIGHT_TEST_BASE_URL=https://app.boardsesh.com vp exec playwright test --config=playwright.production.config.ts',
        cache: false,
      },
    },
  },
});
