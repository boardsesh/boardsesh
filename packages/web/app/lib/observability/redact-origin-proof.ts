import { CLOUDFLARE_ORIGIN_PROOF_HEADER } from '../auth/origin-proof-header';

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
 * `sendDefaultPii: false` keeps every request header that is not an IP header
 * on an error event's `request.headers` (see sentry-railway-request-id.test.ts),
 * and the HTTP integrations copy request headers onto span attributes as
 * `http.request.header.x_boardsesh_origin_proof`. The header's name matches
 * none of the SDK's sensitive-name snippets, so nothing filters it on its own.
 * This deletes every key that names it, at any depth.
 */
export function redactOriginProof<TEvent>(event: TEvent): TEvent {
  deleteOriginProofKeys(event, new WeakSet());
  return event;
}
