/**
 * A request-header transform on our Cloudflare zone overwrites this header with
 * an origin-only secret. Cloudflare addresses alone cannot distinguish our
 * zone's traffic from another account's Worker calling the origin directly.
 *
 * This module has no Node dependencies so edge observability can redact the
 * header without importing the server-only proof verifier.
 */
export const CLOUDFLARE_ORIGIN_PROOF_HEADER = 'X-Boardsesh-Origin-Proof';

/** The header name with `_` read as `-`, so span attribute spellings match too. */
const PROOF_KEY = CLOUDFLARE_ORIGIN_PROOF_HEADER.toLowerCase();

function namesOriginProof(key: string): boolean {
  return key.toLowerCase().replace(/_/g, '-').includes(PROOF_KEY);
}

function deleteOriginProofKeys(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deleteOriginProofKeys(item, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (namesOriginProof(key)) delete record[key];
    else deleteOriginProofKeys(record[key], seen);
  }
}

/**
 * Sentry `beforeSend` / `beforeSendTransaction` / `beforeSendSpan` step: the
 * Cloudflare origin proof never leaves in an event or span.
 *
 * `sendDefaultPii: false` still permits custom request headers. HTTP integrations
 * also copy headers to span attributes such as
 * `http.request.header.x_boardsesh_origin_proof`. Delete keys naming the proof
 * at any depth, including these SDK-specific spellings.
 */
export function redactOriginProof<TEvent>(event: TEvent): TEvent {
  deleteOriginProofKeys(event, new WeakSet());
  return event;
}
