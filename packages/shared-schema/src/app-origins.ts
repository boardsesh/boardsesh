// Single source of truth for the standalone Expo-web app's origin allow-list,
// imported by BOTH trust surfaces:
//   - packages/web/app/lib/auth/app-origin-allowlist.ts — credentialed CORS on
//     www's auth endpoints + the NextAuth redirect callback
//   - packages/backend/src/handlers/cors.ts — the backend's CORS allow-list
// One definition means a look-alike origin can never be trusted by one layer
// while the other rejects it (which would split auth from GraphQL). The runtime
// origin stays env-configurable per service (NEXT_PUBLIC_APP_URL on web,
// APP_ORIGIN on the backend); this module only pins the shared prod default and
// the numbered-preview shape.

// The production origin of the standalone Expo-web app.
export const DEFAULT_APP_ORIGIN = 'https://app.boardsesh.com';

// Flat Pages app previews: https://pr-{N}.boardsesh.com. Their single subdomain
// level avoids the certificate-depth limitation of the earlier homelab names.
// Retain those numbered homelab origins for compatibility. The whole origin is
// anchored (HTTPS, no non-default port or path), so look-alike suffixes and
// arbitrary boardsesh.com subdomains never become trusted auth origins.
export const APP_PREVIEW_ORIGIN_REGEX = /^https:\/\/(?:pr-[1-9][0-9]*\.boardsesh\.com|\d+\.app\.boardsesh\.com)$/;
