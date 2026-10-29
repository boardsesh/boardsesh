import type { CncOrder } from '@boardsesh/db/schema';
import { toPublicOrder } from '../../../services/cnc/orders';
import { orderConfigHash } from '../../../services/cnc/config-hash';
import {
  CNC_PREVIEW_IMAGE_GRANT_TTL_MS,
  createDownloadGrant,
  isDownloadGrantConfigured,
} from '../../../services/cnc/download-grant';
import { backendPublicUrl } from '../../../utils/public-urls';

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

/**
 * What a buyer is told when a free preview failed.
 *
 * Different from the paid message on purpose: nobody has been notified, nobody
 * is going to email them, and the thing that fixes it is theirs to do — ask
 * again, or change the wall.
 */
export const CNC_PUBLIC_PREVIEW_FAILURE_MESSAGE =
  'This preview could not be generated. Try again, or change the configuration.';

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * The watermarked sheets as `<img src>`-ready URLs.
 *
 * Each carries its own one-hour grant rather than the page fetching a link per
 * image: an order page shows five to a dozen of these at once, and a round trip
 * per thumbnail would be a dozen mutations to render one screen.
 *
 * The URL is built from the key's BASENAME, never the key. The stored keys are
 * private-bucket paths, and the route resolves a basename back to a key it
 * already trusts — so nothing a client holds is a path into the bucket.
 *
 * Empty when there are no previews, and also when `CNC_DOWNLOAD_TOKEN_SECRET`
 * is unset: an image URL that cannot be signed is a broken image, and an empty
 * gallery is the honest version of that.
 */
function toPreviewImages(order: CncOrder): { name: string; url: string }[] {
  const keys = order.previewKeys;
  const ownerId = order.userId;
  if (!Array.isArray(keys) || keys.length === 0) return [];
  if (!ownerId || !isDownloadGrantConfigured()) return [];

  const now = new Date();
  return keys.flatMap((key) => {
    const name = key.split('/').pop();
    if (!name) return [];
    const { token } = createDownloadGrant({ orderId: order.id, userId: ownerId }, now, CNC_PREVIEW_IMAGE_GRANT_TTL_MS);
    return [
      {
        name,
        url:
          `${backendPublicUrl()}/api/cnc/packs/${encodeURIComponent(order.licenceId)}` +
          `/preview/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`,
      },
    ];
  });
}

/**
 * One order row as the GraphQL `CncOrder` type.
 *
 * Runs on the output of `toPublicOrder`, so the fingerprint manifest, the claim
 * token, the worker id and the raw error are already gone by the time this is
 * reached — this function cannot leak them because it never sees them.
 *
 * Two fields read off the RAW row, deliberately. `previewKeys` is stripped for
 * the buyer (it is a bucket path) but is what the preview URLs are built from,
 * and `configHash` is recomputed for rows written before that column existed so
 * the field can stay non-null for every order in the list.
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
    errorMessage:
      publicOrder.status === 'failed'
        ? CNC_PUBLIC_FAILURE_MESSAGE
        : publicOrder.status === 'preview_failed'
          ? CNC_PUBLIC_PREVIEW_FAILURE_MESSAGE
          : null,
    // Keyed off the zip, not the images: an order can have PNGs in the bucket
    // and still be mid-completion, and this is what a client gates "Download
    // preview" on.
    hasPreview: publicOrder.previewGeneratedAt !== null,
    previewGeneratedAt: isoOrNull(publicOrder.previewGeneratedAt),
    previewImages: toPreviewImages(order),
    configHash: orderConfigHash(order),
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
