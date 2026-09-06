import type { CncOrder } from '@boardsesh/db/schema';
import { toPublicOrder } from '../../../services/cnc/orders';

/**
 * One place that turns an order row into the GraphQL `CncOrder` type.
 *
 * Queries return orders and so do the mutations that move one along, and both
 * must publish exactly the same shape — a second copy of this mapping is how a
 * field that is redacted on one path ends up published on the other. It lives
 * here rather than in `queries.ts` so the mutation side can import it without
 * pulling the whole read module (and its rate-limit constants) in behind it.
 */

/**
 * What a buyer is told when generation failed.
 *
 * Fixed text, never `lastError`: the generator's message names internal
 * modules, config keys and occasionally file paths. The real error is in the
 * logs and in the admin email.
 */
export const CNC_PUBLIC_FAILURE_MESSAGE =
  'This pack could not be generated. Boardsesh has been notified and will be in touch by email.';

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * One order row as the GraphQL `CncOrder` type.
 *
 * Runs on the output of `toPublicOrder`, so the fingerprint manifest, the claim
 * token, the worker id and the raw error are already gone by the time this is
 * reached — this function cannot leak them because it never sees them.
 */
export function toGraphQLOrder(order: CncOrder) {
  const publicOrder = toPublicOrder(order);
  return {
    id: String(publicOrder.id),
    licenceId: publicOrder.licenceId,
    tier: publicOrder.tier,
    status: publicOrder.status,
    boardName: publicOrder.boardName,
    layoutId: publicOrder.layoutId,
    sizeId: publicOrder.sizeId,
    setIds: publicOrder.setIds,
    options: publicOrder.options,
    artwork: publicOrder.artwork ?? [],
    licenseeName: publicOrder.licenseeName,
    customerSiteName: publicOrder.customerSiteName,
    amountCents: publicOrder.amountCents,
    currency: publicOrder.currency,
    createdAt: publicOrder.createdAt.toISOString(),
    paidAt: isoOrNull(publicOrder.paidAt),
    generatedAt: isoOrNull(publicOrder.generatedAt),
    zipSizeBytes: publicOrder.zipSizeBytes,
    downloadCount: publicOrder.downloadCount,
    lastDownloadedAt: isoOrNull(publicOrder.lastDownloadedAt),
    errorMessage: publicOrder.status === 'failed' ? CNC_PUBLIC_FAILURE_MESSAGE : null,
  };
}

/**
 * One order row as the GraphQL `CncAdminOrder` type.
 *
 * Built on `toGraphQLOrder` rather than beside it: the buyer's shape is the
 * same object an administrator sees, and the three admin-only fields sit
 * alongside it instead of being spliced in. So a field that is redacted for the
 * buyer stays redacted here too, and only what this function names explicitly
 * is added back.
 *
 * The three it names are the operator's whole job. `licenseeEmail` is who to
 * write to (buyer-typed, and often not the account holder), `attempts` says how
 * much of the retry budget a stuck order has left, and `lastError` is the
 * generator's real message — the thing a regenerate decision is made on, and
 * the thing the buyer is deliberately never shown.
 */
export function toGraphQLAdminOrder(order: CncOrder) {
  return {
    order: toGraphQLOrder(order),
    licenseeEmail: order.licenseeEmail,
    attempts: order.attempts,
    lastError: order.lastError,
  };
}
