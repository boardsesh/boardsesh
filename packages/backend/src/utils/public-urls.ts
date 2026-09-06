/**
 * The two public origins the backend builds links against.
 *
 * They started out in `email/email-service.ts` because email was the only
 * thing linking anywhere. It is not any more — Stripe Checkout needs the web
 * origin for the licence terms link, and a payments module importing the mail
 * transport to get at a string is how a module graph turns into a knot. So
 * they live here, with no dependencies of their own, and `email-service`
 * re-exports them for the callers that already had them.
 *
 * Both strip trailing slashes so callers can concatenate a path without
 * producing `//`.
 */

/** Public backend origin (no trailing slash) — used to build the verify link. */
export function backendPublicUrl(): string {
  return (process.env.BACKEND_PUBLIC_URL || 'https://ws.boardsesh.com').replace(/\/+$/, '');
}

/** Public web origin (no trailing slash) — used for admin/success links. */
export function webPublicUrl(): string {
  return (process.env.WEB_PUBLIC_URL || process.env.BOARDSESH_URL || 'https://www.boardsesh.com').replace(/\/+$/, '');
}
