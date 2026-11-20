/**
 * The request header a transform rule on our Cloudflare zone sets on www
 * `/api/auth/` requests (any locale prefix), holding the web's
 * `CLOUDFLARE_ORIGIN_PROOF_SECRET`. A Cloudflare last hop alone proves only
 * that the request crossed some Cloudflare edge: a Worker on any account that
 * fetches our Railway domain leaves from a Cloudflare address, and Cloudflare
 * lets it set `CF-Connecting-IP` itself because that domain is not a Cloudflare
 * zone. Only our zone can add this header.
 *
 * Reexported from a Node-free module, so the edge Sentry config can strip it
 * from events without loading the Node-only proof check.
 */
export { CLOUDFLARE_ORIGIN_PROOF_HEADER } from '@boardsesh/consent/origin-proof';
