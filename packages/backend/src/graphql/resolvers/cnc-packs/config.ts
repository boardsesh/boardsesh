import { GraphQLError } from 'graphql';
import {
  CNC_ARTWORK_FONTS,
  findCatalogEntry,
  isCncArtworkFont,
  parseSetIds,
  validateCatalogOptions,
  validateSetIds,
  type CncCatalogEntry,
  type CncOptionValidationError,
} from '../../../services/cnc/catalog';
import { getOwnedArtAssets } from '../../../services/cnc/art-assets';
import {
  toArtworkItems,
  toLayoutRequest,
  type CncWorkerArtworkItem,
  type CncWorkerLayoutRequest,
} from '../../../services/cnc/worker-client';
import {
  CncBoardConfigInputSchema,
  validateInput,
  type CncArtworkInputValidated,
  type CncBoardConfigInputValidated,
} from '../../../validation/schemas';
import type { CncOrderOptions } from '@boardsesh/db/schema';

/**
 * The one path from a client's `CncBoardConfigInput` to a generator request.
 *
 * Every CNC resolver that touches the generator goes through here, so the
 * catalogue gate cannot be skipped by one of them: shape, then "is this on
 * sale", then "are these options allowed", and only then does a request leave
 * the process. A configuration that fails any of those never costs a round
 * trip.
 */

/** A configuration the buyer can fix: not on sale, bad set ids, an option out of range. */
export const CNC_INVALID_CONFIG_CODE = 'CNC_INVALID_CONFIG';

/** The generator is down or unreachable. Nothing the buyer did; nothing they can fix. */
export const CNC_WORKER_UNAVAILABLE_CODE = 'CNC_WORKER_UNAVAILABLE';

export function invalidConfigError(message: string, fields?: CncOptionValidationError[]): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code: CNC_INVALID_CONFIG_CODE, ...(fields && fields.length > 0 ? { fields } : {}) },
  });
}

export type ResolvedCncConfig = {
  entry: CncCatalogEntry;
  /** Normalised options: every catalogue key present, defaults filled in. */
  options: CncOrderOptions;
  setIds: number[];
  layoutRequest: CncWorkerLayoutRequest;
  artwork: CncWorkerArtworkItem[];
  /** The submitted artwork, shape-checked, in submission order. Empty when there is none. */
  artworkInput: CncArtworkInputValidated[];
};

/**
 * Every asset id the configuration names, deduplicated, in submission order.
 *
 * Its own function because two callers need it for different reasons — one to
 * check ownership before charging, one to stamp the order onto the assets
 * afterwards — and a second inline `.filter().map()` is a second place for the
 * "exactly one of assetId or text" rule to be read wrong.
 */
export function artworkAssetIds(artwork: readonly CncArtworkInputValidated[]): string[] {
  return [...new Set(artwork.map((item) => item.assetId).filter((assetId): assetId is string => Boolean(assetId)))];
}

/**
 * Validate a submitted configuration and translate it for the generator.
 *
 * Throws a `CNC_INVALID_CONFIG` GraphQL error with a stable `extensions.code`
 * rather than returning a result union: every caller's response to a bad
 * configuration is the same (surface it, do nothing else), and a thrown error
 * is what stops a caller forgetting to check.
 */
export function resolveCncConfig(rawConfig: unknown): ResolvedCncConfig {
  const config: CncBoardConfigInputValidated = validateInput(CncBoardConfigInputSchema, rawConfig, 'config');

  const entry = findCatalogEntry({
    boardName: config.boardName,
    layoutId: config.layoutId,
    sizeId: config.sizeId,
  });
  if (!entry) {
    throw invalidConfigError(
      `Boardsesh does not sell a build pack for ${config.boardName} layout ${config.layoutId} size ${config.sizeId}.`,
    );
  }

  const parsedSetIds = parseSetIds(config.setIds);
  if (!parsedSetIds) {
    throw invalidConfigError(`"${config.setIds}" is not a valid set id list.`);
  }

  // Shape is not membership: a well-formed list can still name sets from
  // another wall, or drop a mandatory one. The catalogue decides.
  const setIdsResult = validateSetIds(entry, parsedSetIds);
  if (!setIdsResult.ok) {
    throw invalidConfigError(setIdsResult.errors.join(' '));
  }
  const setIds = setIdsResult.setIds;

  const optionsResult = validateCatalogOptions(entry, config.options);
  if (!optionsResult.ok) {
    throw invalidConfigError(optionsResult.errors.map((error) => error.message).join(' '), optionsResult.errors);
  }

  const artworkInput = config.artwork ?? [];

  // The generator refuses an unbundled font rather than substituting one, so an
  // unknown face here is a paid order that fails at build time. Caught before
  // any request leaves the process, and named in the message: "that font does
  // not exist" is actionable, "the generator rejected your configuration" is
  // not.
  for (const item of artworkInput) {
    if (item.font != null && !isCncArtworkFont(item.font)) {
      throw invalidConfigError(
        `"${item.font}" is not a font we can route. Pick one of: ${CNC_ARTWORK_FONTS.join(', ')}.`,
      );
    }
  }

  return {
    entry,
    options: optionsResult.options,
    setIds,
    layoutRequest: toLayoutRequest({ entry, options: optionsResult.options, setIds }),
    artwork: toArtworkItems(
      artworkInput.map((item) => ({
        assetId: item.assetId ?? null,
        text: item.text ?? null,
        font: item.font ?? null,
        mode: item.mode,
        placement: item.placement,
      })),
    ),
    artworkInput,
  };
}

/**
 * One stored artwork entry, as it is written onto the order row.
 *
 * A superset of what the buyer submitted: the asset's `assetKey` and `mime` are
 * copied in at checkout so the order stays readable after the upload row is
 * gone. `cnc_art_assets.user_id` cascades — closing an account erases the
 * uploads — while the licence (and the right to a regenerate) survives it, so
 * an order that only held an asset ID would lose its artwork the day its buyer
 * deleted their account.
 */
export type StoredCncArtworkItem = {
  assetId: string | null;
  /** Object key in the private bucket. Null for a text label. */
  assetKey: string | null;
  /** The asset's content type. Null for a text label. */
  mime: string | null;
  text: string | null;
  font: string | null;
  mode: string;
  placement: CncArtworkInputValidated['placement'];
};

/**
 * Check that every asset the configuration names belongs to this buyer, and
 * return the artwork as it should be stored.
 *
 * Async and separate from `resolveCncConfig` because ownership is a database
 * question and that function is deliberately pure. Both callers run it —
 * artwork validation as well as checkout — so there is no path where a buyer
 * can point the generator at somebody else's upload, not even to ask whether it
 * fits.
 *
 * An unknown id and a foreign one produce the same error, for the same reason
 * `getOwnedArtAsset` returns null for both: a distinguishable "exists but not
 * yours" is an oracle for which uploads are real.
 */
export async function resolveArtworkAssets(
  userId: string,
  artwork: readonly CncArtworkInputValidated[],
): Promise<StoredCncArtworkItem[]> {
  const assetIds = artworkAssetIds(artwork);
  const owned = await getOwnedArtAssets(userId, assetIds);

  const missing = assetIds.filter((assetId) => !owned.has(assetId));
  if (missing.length > 0) {
    throw invalidConfigError(
      missing.length === 1
        ? 'That artwork upload is not one of yours. Upload it again and retry.'
        : 'Some of that artwork is not yours. Upload it again and retry.',
    );
  }

  return artwork.map((item) => {
    const asset = item.assetId ? owned.get(item.assetId) : undefined;
    return {
      assetId: item.assetId ?? null,
      assetKey: asset?.key ?? null,
      mime: asset?.mime ?? null,
      text: item.text ?? null,
      // Stored only for a label. An SVG carries its own outlines, so a face
      // name on one is a value nothing downstream can apply.
      font: item.assetId ? null : (item.font ?? null),
      mode: item.mode,
      placement: item.placement,
    };
  });
}
