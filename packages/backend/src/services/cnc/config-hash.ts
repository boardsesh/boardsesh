import { createHash } from 'node:crypto';
import type { CncOrder, CncOrderArtworkItem, CncOrderOptions } from '@boardsesh/db/schema';

/**
 * The identity of a configuration, as one sha256.
 *
 * Previews are free and generation is not, so the second identical
 * `createCncPreview` must return the first preview rather than queue another
 * job. That needs a stable name for "the same configuration", and object
 * identity will not do it: the buyer's client rebuilds the options object on
 * every render, key order follows whatever the UI iterated last, and the
 * catalogue fills in defaults the client never sent.
 *
 * So the hash runs over the NORMALISED configuration — the tuple, the options
 * as `resolveCncConfig` returned them (every catalogue key present, defaults
 * filled in) and the artwork — serialised with sorted keys. Two buyers who
 * configure the same wall by different routes land on the same hash, and a
 * single moved millimetre lands on a different one.
 */

/**
 * What a hash is taken over. A subset of the order row on purpose: the licence
 * id, the buyer, the timestamps and the payment are all facts ABOUT an order,
 * not part of the configuration it generates from.
 */
export type CncHashableConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  options: CncOrderOptions;
  artwork: CncOrderArtworkItem[] | null;
};

/**
 * The artwork fields that change what gets routed.
 *
 * `assetKey` and `mime` are deliberately absent: they are looked up from the
 * asset row at resolve time and say nothing the `assetId` does not already say.
 * Including them would make one buyer's re-upload of the identical file read as
 * a different configuration.
 */
const HASHED_ARTWORK_FIELDS = ['assetId', 'text', 'font', 'mode'] as const;
const HASHED_PLACEMENT_FIELDS = ['panelIndex', 'xMm', 'yMm', 'widthMm', 'rotationDeg'] as const;

/** A JSON value with object keys in sorted order, so key order cannot change the hash. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` disappears in JSON anyway; dropping it here keeps a key that
    // was explicitly set to undefined from sorting differently to one that was
    // never set at all.
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, canonicalise(entryValue)]));
}

/** One artwork item reduced to the fields that change the cut. */
function hashableArtworkItem(raw: CncOrderArtworkItem): Record<string, unknown> {
  const item = raw as Record<string, unknown>;
  const placement = (typeof item.placement === 'object' && item.placement !== null ? item.placement : {}) as Record<
    string,
    unknown
  >;
  return {
    ...Object.fromEntries(HASHED_ARTWORK_FIELDS.map((field) => [field, item[field] ?? null])),
    placement: Object.fromEntries(HASHED_PLACEMENT_FIELDS.map((field) => [field, placement[field] ?? null])),
  };
}

/**
 * The hash for one configuration, as 64 lowercase hex characters.
 *
 * Artwork order is preserved rather than sorted: two items swapped in the list
 * are the same wall, but they are also a configuration the buyer edited, and
 * pretending otherwise would hand them back a preview whose gallery is in the
 * other order.
 */
export function computeCncConfigHash(config: CncHashableConfig): string {
  const canonical = canonicalise({
    boardName: config.boardName,
    layoutId: config.layoutId,
    sizeId: config.sizeId,
    setIds: config.setIds,
    options: config.options,
    artwork: (config.artwork ?? []).map(hashableArtworkItem),
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * An order's config hash, computed if the column is empty.
 *
 * `config_hash` arrived with the preview flow (migration 0218), so orders
 * bought before it have none. The hash is a pure function of columns those rows
 * do carry, which is what lets `CncOrder.configHash` stay non-null in the schema
 * instead of making every client handle a hole in the middle of the order list.
 */
export function orderConfigHash(order: Pick<CncOrder, 'configHash' | keyof CncHashableConfig>): string {
  return order.configHash ?? computeCncConfigHash(order);
}
