import { defineConfig } from 'vite-plus';

// Standalone Vitest project for deploy/app-subdomain — the Cloudflare Pages
// config for app.boardsesh.com (see README.md). These aren't part of any
// package, so they get their own project (same pattern as scripts/vite.config.ts)
// registered in the root vite.config.ts's test.projects.
export default defineConfig({
  test: {
    name: 'deploy-app-subdomain',
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
});
