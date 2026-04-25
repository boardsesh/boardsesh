import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
  },
  lint: {
    options: {
      // typeCheck runs tsgolint (the TypeScript Go rewrite) for fast type
      // checking. typeAware enables the extra type-aware oxlint rules; vp
      // currently requires it whenever typeCheck is on, otherwise lint
      // refuses to start.
      typeAware: true,
      typeCheck: true,
    },
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
    '*.{ts,tsx,js,mjs,cjs}': 'vp check --fix',
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
      'db:import-moonboard': {
        command: 'bun run --filter=@boardsesh/db db:import-moonboard',
        dependsOn: ['db:up'],
        cache: false,
      },

      // --- Build (topological order via dependsOn) ---
      'build:shared': {
        command: 'bun run --filter=@boardsesh/shared-schema build',
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
