import { defineConfig } from 'vite-plus';

const shellQuote = (filePath: string) => `'${filePath.replaceAll("'", "'\\''")}'`;
const isGeneratedFile = (filePath: string) => filePath.includes('/generated/');

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
    ignore: ['design/**', '**/generated/**'],
  },
  lint: {
    ignorePatterns: ['**/board-controller/**', 'mobile/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      // Backend uses the winston logger at packages/backend/src/utils/logger.ts.
      // Block all console.* in production code; allow warn/error/info in tests
      // (test infra emits orchestration noise via console).
      // See docs/logging.md and commit f91697a.
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
    ],
  },
  staged: {
    '*.{ts,tsx,js,mjs,cjs}': (stagedFileNames) => {
      const lintableFileNames = stagedFileNames.filter((fileName) => !isGeneratedFile(fileName));
      return lintableFileNames.length > 0 ? `vp check --fix ${lintableFileNames.map(shellQuote).join(' ')}` : [];
    },
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
          'bun packages/shared-schema/scripts/print-schema.ts && graphql-codegen && vp fmt packages/shared-schema/src/generated/ packages/web/app/lib/graphql/generated/',
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
      'build:aurora': {
        command: 'bun run --filter=@boardsesh/aurora-sync build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db'],
      },
      'build:backend': {
        command: 'bun run --filter=boardsesh-backend build',
        dependsOn: ['build:shared', 'build:crypto', 'build:db', 'build:constants', 'build:aurora'],
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
      typecheck: {
        command: 'true',
        dependsOn: ['typecheck:shared', 'typecheck:db', 'typecheck:backend', 'typecheck:web'],
      },

      // --- Dev servers ---
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
