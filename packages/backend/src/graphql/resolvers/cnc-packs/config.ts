import { GraphQLError } from 'graphql';
import {
  findCatalogEntry,
  parseSetIds,
  validateCatalogOptions,
  validateSetIds,
  type CncCatalogEntry,
  type CncOptionValidationError,
} from '../../../services/cnc/catalog';
import {
  toArtworkItems,
  toLayoutRequest,
  type CncWorkerArtworkItem,
  type CncWorkerLayoutRequest,
} from '../../../services/cnc/worker-client';
import {
  CncBoardConfigInputSchema,
  validateInput,
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
};

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

  return {
    entry,
    options: optionsResult.options,
    setIds,
    layoutRequest: toLayoutRequest({ entry, options: optionsResult.options, setIds }),
    artwork: toArtworkItems(
      (config.artwork ?? []).map((item) => ({
        assetId: item.assetId ?? null,
        text: item.text ?? null,
        mode: item.mode,
        placement: item.placement,
      })),
    ),
  };
}
