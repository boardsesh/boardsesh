import { defineConfig } from 'vitest/config';

// Configuration for pure unit tests that don't require a database connection,
// run under stock `vitest` (NOT the `vp` / vite-plus runner — this config is
// only ever invoked by an explicit `--config` flag, never by `vp test`).
//
// Run from this package dir:
//   vitest run --config vitest.unit.config.ts
// or from the repo root with an explicit path:
//   vitest run packages/backend/src/<file>.unit.test.ts --config packages/backend/vitest.unit.config.ts
//
// `root` is pinned to this config's directory so the `src/**` include glob and
// any positional path filter resolve against packages/backend no matter the cwd
// (stock vitest otherwise roots at the cwd, so a repo-root invocation finds
// nothing). Tests collected here must import from 'vitest' only — a file that
// imports 'vite-plus/test' belongs to the `vp` runner and won't load here.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'backend-unit',
    globals: true,
    environment: 'node',
    include: ['src/**/*.unit.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 10000,
  },
});
