// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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

// Numbered homelab app previews: https://{N}.app.boardsesh.com. `^…$`-anchored
// and matched against a full origin (scheme+host+port, no path), so look-alikes
// such as https://app.boardsesh.com.evil.com or https://evil-app.boardsesh.com
// never match.
export const APP_PREVIEW_ORIGIN_REGEX = /^https:\/\/\d+\.app\.boardsesh\.com$/;
