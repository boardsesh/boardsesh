/**
 * Resolves the Stripe Payment Link behind the one-time donation rail on
 * `/support`.
 *
 * Deliberately NOT `NEXT_PUBLIC_`. A `NEXT_PUBLIC_` value is inlined at build
 * time, and neither `Dockerfile.web` nor `production-deploy.yml` passes one as a
 * build arg — so a prefixed var could never be set in production at all. This is
 * read only from a server component, so it resolves per request from the Railway
 * web service's own environment (see `docs/production-deploy.md`).
 *
 * Anything that is not an `https://` URL is treated as unset. A misconfigured
 * value must hide the rail, never point a donate button somewhere else.
 */
export function resolveStripeDonateUrl(rawValue = process.env.STRIPE_DONATE_URL): string | undefined {
  return rawValue?.startsWith('https://') ? rawValue : undefined;
}
