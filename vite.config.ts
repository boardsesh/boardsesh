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
    ignore: ['design/**', '**/generated/**', '**/board-controller/**'],
  },
  lint: {
    ignorePatterns: ['**/board-controller/**', 'mobile/**', 'packages/mobile/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
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
      './packages/sync-runtime/vite.config.ts',
      './packages/crypto/vite.config.ts',
      './packages/shared/ble-protocol/vite.config.ts',
      './packages/shared/board-config/vite.config.ts',
      './packages/shared/board-react/vite.config.ts',
      './packages/shared/queue/vite.config.ts',
      './packages/shared/queue-runtime/vite.config.ts',
      './packages/shared/queue-react/vite.config.ts',
      './packages/shared/playlists-react/vite.config.ts',
      './packages/shared/party-profile/vite.config.ts',
      './packages/shared/climb-actions/vite.config.ts',
      './packages/shared/key-value-storage/vite.config.ts',
      './packages/shared/play-view/vite.config.ts',
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
        command: 'bun run --filter=@boardsesh/db db:seed-locations',
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
      'build:aurora': {
        command: 'bun run --filter=@boardsesh/aurora-sync build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:sync-runtime'],
      },
      'build:kilter': {
        command: 'bun run --filter=@boardsesh/kilter-sync build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:sync-runtime'],
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
        dependsOn: ['build:backend', 'build:web'],
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
      'typecheck:playlists-react': {
        command: 'bun run --filter=@boardsesh/playlists-react typecheck',
      },
      'typecheck:board-react': {
        command: 'bun run --filter=@boardsesh/board-react typecheck',
      },
      'typecheck:party-profile': {
        command: 'bun run --filter=@boardsesh/party-profile typecheck',
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
      'typecheck:playlist-generator': {
        command: 'bun run --filter=@boardsesh/playlist-generator typecheck',
      },
      'typecheck:climb-filters': {
        command: 'bun run --filter=@boardsesh/climb-filters typecheck',
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
          'typecheck:playlists-react',
          'typecheck:board-react',
          'typecheck:party-profile',
          'typecheck:climb-actions',
          'typecheck:key-value-storage',
          'typecheck:board-config',
          'typecheck:play-view',
          'typecheck:playlist-generator',
          'typecheck:climb-filters',
          'typecheck:i18n',
          'typecheck:graphql',
          'typecheck:graphql-client',
          'typecheck:mobile',
          'typecheck:kilter',
          'typecheck:sync-runtime',
        ],
      },

      // --- Mobile validation ---
      'check:mobile-native-deps': {
        command: 'tsx scripts/mobile-native-deps-check.ts',
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
      'mobile:screenshot': {
        command: 'bash scripts/mobile-screenshot.sh',
        cache: false,
      },
      'mobile:publish': {
        command: 'tsx scripts/mobile-publish.ts',
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
