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
    ignore: ['design/**', '**/generated/**', '**/board-controller/**', 'CHANGELOG.md'],
  },
  lint: {
    ignorePatterns: ['**/board-controller/**'],
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
      './packages/crypto/vite.config.ts',
      './packages/shared/ble-protocol/vite.config.ts',
      './packages/shared/board-config/vite.config.ts',
      './packages/shared/board-react/vite.config.ts',
      './packages/shared/create-climb-react/vite.config.ts',
      './packages/shared/queue/vite.config.ts',
      './packages/shared/queue-runtime/vite.config.ts',
      './packages/shared/board-presence/vite.config.ts',
      './packages/shared/board-presence-react/vite.config.ts',
      './packages/shared/queue-react/vite.config.ts',
      './packages/shared/playlists-react/vite.config.ts',
      './packages/shared/party-profile/vite.config.ts',
      './packages/shared/analytics/vite.config.ts',
      './packages/shared/climb-actions/vite.config.ts',
      './packages/shared/key-value-storage/vite.config.ts',
      './packages/shared/play-view/vite.config.ts',
      './packages/shared/playback-react/vite.config.ts',
      './packages/shared/profile-stats/vite.config.ts',
      './packages/shared/playlist-generator/vite.config.ts',
      './packages/shared/climb-filters/vite.config.ts',
      './packages/shared/i18n/vite.config.ts',
      './packages/shared/graphql/vite.config.ts',
      './packages/shared/graphql-client/vite.config.ts',
      './packages/shared-schema/vite.config.ts',
      './packages/mobile/vite.config.ts',
      './scripts/vite.config.ts',
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
  },
  run: {
    tasks: {
      // --- Database ---
      'db:up': {
        command: 'sh scripts/dev-db-up.sh',
        cache: false,
      },
      'db:migrate': {
        command: 'bun run --filter=@boardsesh/db db:migrate',
        dependsOn: ['db:up'],
        cache: false,
      },
      'db:studio': {
        command: 'bun run --filter=@boardsesh/db db:studio',
        dependsOn: ['db:up'],
        cache: false,
      },
      'db:seed-social': {
        command: 'bun run --filter=@boardsesh/db db:seed-social',
        dependsOn: ['db:up'],
        cache: false,
      },
      'db:create-test-user': {
        command: 'bun run --filter=@boardsesh/db db:create-test-user',
        dependsOn: ['db:up'],
        cache: false,
      },
      'db:seed-locations': {
        command: 'true',
        dependsOn: ['locations:aurora', 'locations:kilter', 'locations:moonboard'],
        cache: false,
      },
      'db:dedupe-gyms': {
        command: 'bun run --filter=@boardsesh/db db:dedupe-gyms',
        // Intentionally no db:up dependency: this maintenance/reporting command
        // often targets DB_URL against a remote database instead of local Docker.
        cache: false,
      },
      'test:db': {
        command: 'bun run --filter=@boardsesh/db test',
      },
      'locations:aurora': {
        command: 'bun run --filter=@boardsesh/aurora-sync sync:locations',
        dependsOn: ['db:up'],
        cache: false,
      },
      'locations:kilter': {
        command: 'bun run --filter=@boardsesh/kilter-sync sync:locations',
        dependsOn: ['db:up'],
        cache: false,
      },
      'locations:moonboard': {
        command: 'bun run --filter=@boardsesh/moonboard-sync sync:locations',
        dependsOn: ['db:up'],
        cache: false,
      },
      'seed:beta-links': {
        command: 'bun run --filter=@boardsesh/db db:seed-beta-links',
        dependsOn: ['db:up'],
        cache: false,
      },
      'db:import-moonboard': {
        command: 'bun run --filter=@boardsesh/db db:import-moonboard',
        dependsOn: ['db:up'],
        cache: false,
      },

      // --- Codegen (GraphQL types for client + backend resolvers) ---
      // Direct binary invocation — no `bunx` (won't touch the lockfile).
      // print-schema concatenates the modular gql typeDefs into a single SDL
      // file that graphql-codegen reads as its schema input.
      codegen: {
        command:
          'bun packages/shared-schema/scripts/print-schema.ts && graphql-codegen && vp fmt packages/shared-schema/src/generated/ packages/shared/graphql/src/generated/',
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
        command: 'bun run --filter=@boardsesh/shared-schema build',
        dependsOn: ['codegen'],
      },
      'build:crypto': {
        command: 'bun run --filter=@boardsesh/crypto build',
      },
      'build:constants': {
        command: 'bun run --filter=@boardsesh/board-constants build',
        dependsOn: ['build:shared'],
      },
      'build:db': {
        command: 'bun run --filter=@boardsesh/db build',
        dependsOn: ['build:shared'],
      },
      'build:sync-runtime': {
        command: 'bun run --filter=@boardsesh/sync-runtime build',
      },
      'build:location-sync': {
        command: 'bun run --filter=@boardsesh/location-sync build',
        dependsOn: ['build:shared', 'build:constants', 'build:db'],
      },
      'build:moonboard-sync': {
        command: 'bun run --filter=@boardsesh/moonboard-sync build',
        dependsOn: ['build:db', 'build:location-sync'],
      },
      'build:aurora': {
        command: 'bun run --filter=@boardsesh/aurora-sync build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:location-sync', 'build:sync-runtime'],
      },
      'build:kilter': {
        command: 'bun run --filter=@boardsesh/kilter-sync build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:location-sync', 'build:sync-runtime'],
      },
      'build:backend': {
        command: 'bun run --filter=boardsesh-backend build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:constants', 'build:aurora', 'build:kilter'],
      },
      'build:web': {
        command: 'bun run --filter=@boardsesh/web build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:constants'],
      },
      'verify:graphql-treeshake': {
        command: 'bun packages/web/scripts/verify-graphql-treeshake.ts',
        dependsOn: ['build:web'],
        cache: false,
      },
      'check:i18n': {
        command: 'bun packages/web/scripts/check-untranslated-strings.ts',
        cache: false,
      },
      'check:i18n:orphans': {
        command: 'bun packages/web/scripts/check-orphaned-i18n-keys.ts',
        cache: false,
      },
      'check:mobile-board-art-network': {
        command: 'bun scripts/mobile-board-art-network-check.ts',
        cache: false,
      },
      'generate:acknowledgements': {
        command: 'node --import tsx scripts/fetch-acknowledgements.ts',
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
      'check:changelog': {
        command: 'node --import tsx scripts/generate-changelog.ts --check',
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
      'generate:ios-board-placement-data': {
        command: 'node --import tsx packages/board-constants/scripts/generate-ios-board-placement-data.ts',
        dependsOn: ['build:constants'],
        cache: false,
      },
      'check:ios-board-placement-data': {
        command: 'node --import tsx packages/board-constants/scripts/generate-ios-board-placement-data.ts --check',
        dependsOn: ['build:constants'],
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
        command: 'node --test scripts/check-service-deploy-inputs.test.mjs scripts/railway-deployment-status.test.mjs',
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
      'typecheck:shared': {
        command: 'bun run --filter=@boardsesh/shared-schema typecheck',
        dependsOn: ['build:shared'],
      },
      'typecheck:db': {
        command: 'bun run --filter=@boardsesh/db typecheck',
        dependsOn: ['build:db'],
      },
      'typecheck:backend': {
        command: 'bun run --filter=boardsesh-backend typecheck',
        dependsOn: ['build:backend'],
      },
      'typecheck:web': {
        command: 'bun run --filter=@boardsesh/web typecheck',
        dependsOn: ['build:web'],
      },
      'typecheck:ble-protocol': {
        command: 'bun run --filter=@boardsesh/ble-protocol typecheck',
      },
      'typecheck:queue': {
        command: 'bun run --filter=@boardsesh/queue typecheck',
      },
      'typecheck:queue-runtime': {
        command: 'bun run --filter=@boardsesh/queue-runtime typecheck',
      },
      'typecheck:queue-react': {
        command: 'bun run --filter=@boardsesh/queue-react typecheck',
      },
      'typecheck:board-presence': {
        command: 'bun run --filter=@boardsesh/board-presence typecheck',
        dependsOn: ['build:shared'],
      },
      'typecheck:board-presence-react': {
        command: 'bun run --filter=@boardsesh/board-presence-react typecheck',
        dependsOn: ['build:shared'],
      },
      'typecheck:playlists-react': {
        command: 'bun run --filter=@boardsesh/playlists-react typecheck',
      },
      'typecheck:board-react': {
        command: 'bun run --filter=@boardsesh/board-react typecheck',
      },
      'typecheck:create-climb-react': {
        command: 'bun run --filter=@boardsesh/create-climb-react typecheck',
      },
      'typecheck:party-profile': {
        command: 'bun run --filter=@boardsesh/party-profile typecheck',
      },
      'typecheck:analytics': {
        command: 'bun run --filter=@boardsesh/analytics typecheck',
      },
      'typecheck:climb-actions': {
        command: 'bun run --filter=@boardsesh/climb-actions typecheck',
      },
      'typecheck:key-value-storage': {
        command: 'bun run --filter=@boardsesh/key-value-storage typecheck',
      },
      'typecheck:board-config': {
        command: 'bun run --filter=@boardsesh/board-config typecheck',
      },
      'typecheck:play-view': {
        command: 'bun run --filter=@boardsesh/play-view typecheck',
      },
      'typecheck:playback-react': {
        command: 'bun run --filter=@boardsesh/playback-react typecheck',
        dependsOn: ['build:constants'],
      },
      'typecheck:profile-stats': {
        command: 'bun run --filter=@boardsesh/profile-stats typecheck',
        dependsOn: ['build:constants'],
      },
      'typecheck:playlist-generator': {
        command: 'bun run --filter=@boardsesh/playlist-generator typecheck',
      },
      'typecheck:climb-filters': {
        command: 'bun run --filter=@boardsesh/climb-filters typecheck',
        dependsOn: ['codegen'],
      },
      'typecheck:i18n': {
        command: 'bun run --filter=@boardsesh/i18n typecheck',
      },
      'typecheck:graphql': {
        command: 'bun run --filter=@boardsesh/graphql typecheck',
        dependsOn: ['codegen'],
      },
      'typecheck:graphql-client': {
        command: 'bun run --filter=@boardsesh/graphql-client typecheck',
      },
      'typecheck:mobile': {
        command: 'bun run --filter=@boardsesh/mobile typecheck',
        dependsOn: ['build:shared', 'build:constants'],
      },
      'typecheck:kilter': {
        command: 'bun run --filter=@boardsesh/kilter-sync typecheck',
        dependsOn: ['build:kilter'],
      },
      'typecheck:aurora': {
        command: 'bun run --filter=@boardsesh/aurora-sync typecheck',
        dependsOn: ['build:aurora'],
      },
      'typecheck:location-sync': {
        command: 'bun run --filter=@boardsesh/location-sync typecheck',
        dependsOn: ['build:location-sync'],
      },
      'typecheck:moonboard-sync': {
        command: 'bun run --filter=@boardsesh/moonboard-sync typecheck',
        dependsOn: ['build:moonboard-sync'],
      },
      'typecheck:sync-runtime': {
        command: 'bun run --filter=@boardsesh/sync-runtime typecheck',
        dependsOn: ['build:sync-runtime'],
      },
      typecheck: {
        command: 'true',
        dependsOn: [
          'typecheck:shared',
          'typecheck:db',
          'typecheck:backend',
          'typecheck:web',
          'typecheck:ble-protocol',
          'typecheck:queue',
          'typecheck:queue-runtime',
          'typecheck:queue-react',
          'typecheck:board-presence',
          'typecheck:board-presence-react',
          'typecheck:playlists-react',
          'typecheck:board-react',
          'typecheck:create-climb-react',
          'typecheck:party-profile',
          'typecheck:analytics',
          'typecheck:climb-actions',
          'typecheck:key-value-storage',
          'typecheck:board-config',
          'typecheck:play-view',
          'typecheck:playback-react',
          'typecheck:profile-stats',
          'typecheck:playlist-generator',
          'typecheck:climb-filters',
          'typecheck:i18n',
          'typecheck:graphql',
          'typecheck:graphql-client',
          'typecheck:mobile',
          'typecheck:kilter',
          'typecheck:aurora',
          'typecheck:location-sync',
          'typecheck:moonboard-sync',
          'typecheck:sync-runtime',
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

      // --- Mobile validation ---
      'check:mobile-native-deps': {
        command: 'tsx scripts/mobile-native-deps-check.ts',
        cache: false,
      },
      'check:mobile-ota-compat': {
        command: 'tsx scripts/mobile-ota-compat-check.ts',
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
      'check:mobile-bundle': {
        command: 'bash scripts/mobile-bundle-check.sh',
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
      'mobile:android-diagnostic-apk': {
        command: 'tsx scripts/mobile-android-diagnostic-apk.ts',
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
      'mobile:ota-setup': {
        command: 'tsx scripts/mobile-ota-setup.ts',
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

      // --- Dev servers ---
      'dev:mobile': {
        command: 'tsx scripts/mobile-dev-start.ts',
        cache: false,
      },
      'dev:backend': {
        command: 'bun run --filter=boardsesh-backend dev',
        dependsOn: ['db:up'],
        cache: false,
      },
      'dev:web': {
        command: 'bun run --filter=@boardsesh/web dev',
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
        command: 'TEST_USER_EMAIL=test@boardsesh.com TEST_USER_PASSWORD=test bun run --filter=@boardsesh/web test:e2e',
        dependsOn: ['db:up'],
        cache: false,
      },
      'test:e2e:setup': {
        command: 'true',
        dependsOn: ['db:up'],
        cache: false,
      },
    },
  },
});
