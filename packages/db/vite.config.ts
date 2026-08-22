import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    name: 'db',
    /**
     * Scoped to `src/queries/sitemap/**`, and the narrowness is deliberate.
     *
     * `packages/db` was absent from the root `test.projects` list entirely until
     * #4583, so nothing in it ran under `vp test`. The obvious widening —
     * `src/**\/*.test.ts` — does not work: all ~25 existing files under `src/`
     * are **node:test** suites (`import { test } from 'node:test'`), run by the
     * package's own `tsx --test` script, and vitest fails to collect every one of
     * them. Only `migration-owner-role.test.ts` is actually executed in CI, from
     * the db-migrations lane.
     *
     * So this opens the door one directory wide for the tier-2 sitemap helpers,
     * which CLAUDE.md wants living next to their code, and leaves the
     * node:test-vs-vitest split for someone who is fixing that on purpose. Widen
     * the glob only alongside converting the suites it would pull in.
     */
    include: ['src/queries/sitemap/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
