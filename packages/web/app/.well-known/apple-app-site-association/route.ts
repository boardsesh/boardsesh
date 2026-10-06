// Relative on purpose: TypeScript's include globs skip dot-directories, so the
// type-aware linter checks this file outside the project and cannot resolve the
// `@/` alias from here.
import { buildAppleAppSiteAssociation } from '../../lib/apple-app-site-association';

// Which paths open the app and which stay in the browser is decided in
// app/lib/apple-app-site-association.ts. Apple's CDN fetches this file, not the
// phone, and a phone asks the CDN again on install, on app update and roughly
// weekly after that, so a change here takes days to reach existing installs.
export function GET(): Response {
  return new Response(JSON.stringify(buildAppleAppSiteAssociation()), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
