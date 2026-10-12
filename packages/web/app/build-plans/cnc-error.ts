/**
 * Turn a GraphQL failure into the one thing the buyer needs: which of these
 * four things went wrong.
 *
 * The backend keeps the cases apart on purpose (see `toGraphQLWorkerError` in
 * packages/backend/src/graphql/resolvers/cnc-packs/queries.ts):
 * `CNC_INVALID_CONFIG` means change something, `CNC_WORKER_UNAVAILABLE` means
 * try again shortly, `CNC_CHECKOUT_UNAVAILABLE` means payments are down. A UI
 * that collapses them into "something went wrong" leaves the buyer with a
 * genuinely bad configuration retrying it forever, which is exactly the
 * confusion the codes exist to prevent.
 *
 * The returned value is an i18n key suffix under `errors.` in the `cnc`
 * namespace, so a new code is a catalog entry plus one line here.
 */

const KNOWN_ERROR_CODES = [
  'CNC_INVALID_CONFIG',
  'CNC_WORKER_UNAVAILABLE',
  'CNC_CHECKOUT_UNAVAILABLE',
  // The free-preview ceiling. Its own case because it is the one failure on
  // this surface that is not a fault: the previews the buyer already asked for
  // are still there, and the answer is "come back on the hour", not "try again
  // in a minute". The backend raises it as `RATE_LIMITED` from both the burst
  // guard and the hourly count.
  'RATE_LIMITED',
] as const;

export type CncErrorKey = (typeof KNOWN_ERROR_CODES)[number] | 'generic';

/**
 * `graphql-request` throws a `ClientError` whose `response.errors[]` carries
 * the `extensions.code` the resolver set. Nothing here uses `instanceof`: the
 * shape is walked defensively so a transport error, an aborted fetch or a
 * proxy's HTML error page all land on `generic` instead of throwing inside the
 * error handler.
 */
export function cncErrorKey(error: unknown): CncErrorKey {
  if (typeof error !== 'object' || error === null) return 'generic';

  const response = (error as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null) return 'generic';

  const errors = (response as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return 'generic';

  for (const entry of errors) {
    if (typeof entry !== 'object' || entry === null) continue;
    const extensions = (entry as { extensions?: unknown }).extensions;
    if (typeof extensions !== 'object' || extensions === null) continue;
    const code = (extensions as { code?: unknown }).code;
    const match = KNOWN_ERROR_CODES.find((known) => known === code);
    if (match) return match;
  }

  return 'generic';
}
