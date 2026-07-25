// Single source of truth for "is this browser tab running on a production
// boardsesh.com host". Exact-host match, NOT a substring: preview deploys run
// at `<pr>.preview.boardsesh.com` (branch-deploy.yml), which CONTAINS
// "boardsesh.com" and would pass a naive `.includes()` check. That gap let
// every PR-preview browser session leak into prod Sentry (#3808) and prod
// PostHog (#3814).
//
// Deliberately excludes app.boardsesh.com: that host is a fully separate
// deployment (the standalone Expo-web static export served by Cloudflare
// Pages — see docs/expo-web-deployment.md), not this Next.js app, so it can
// never legitimately load this code.
//
// Shared by instrumentation-client.ts (Sentry) and analytics.ts (PostHog) so
// the two production-gates can't drift apart the way they did before #3808.
export const PRODUCTION_HOSTS: ReadonlySet<string> = new Set(['boardsesh.com', 'www.boardsesh.com']);

export function isProductionHost(hostname: string): boolean {
  return PRODUCTION_HOSTS.has(hostname);
}
