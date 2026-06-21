// Dedupe marker for errors a resolver-level catch has already reported to Sentry
// with finer-grained tags/context. The generic graphql-yoga error handler
// (yoga.ts) checks this before its own capture so a single failure produces a
// single Sentry event.
//
// graphql-js wraps a thrown resolver error in a GraphQLError whose `originalError`
// is the exact thrown error, so the resolver marks the original and the Yoga
// handler sees the wrapper — `wasErrorReported` therefore checks both. A global
// `Symbol.for` keeps the marker non-enumerable (it won't leak into logs or
// serialization) and stable even if this module is evaluated more than once.

const REPORTED = Symbol.for('boardsesh.sentryReported');

export function markErrorReported(err: unknown): void {
  if (err && typeof err === 'object') {
    (err as Record<symbol, unknown>)[REPORTED] = true;
  }
}

export function wasErrorReported(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as Record<symbol, unknown>)[REPORTED]) return true;
  const original = (err as { originalError?: unknown }).originalError;
  return !!original && typeof original === 'object' && !!(original as Record<symbol, unknown>)[REPORTED];
}
