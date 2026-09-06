import type { CncOrder, CncOrderOptions } from '@boardsesh/db/schema';
import { parseSetIds } from './catalog';
import { toLayoutRequest, type CncWorkerLayoutRequest } from './worker-client';

/**
 * One generation job, as the pack generator receives it.
 *
 * This is the whole contract between Boardsesh and the worker: everything the
 * generator needs to build and upload a pack, and nothing else. It is built
 * from the ORDER ROW rather than from the live catalogue on purpose — the row
 * records what was paid for, so a regenerate months after a catalogue change
 * rebuilds the pack the buyer bought instead of today's defaults.
 *
 * camelCase here, unlike the snake_case `layoutRequest` nested inside it. The
 * job is Boardsesh's own envelope; `layoutRequest` is the generator's pydantic
 * model, byte-identical to what `POST /layout` takes, so the worker can hand it
 * straight to `compute_layout` without a second translation.
 */

/** The order cannot be turned into a job. Never retryable: nothing about it changes on the next attempt. */
export class CncJobPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CncJobPayloadError';
  }
}

/** One artwork item on the job. */
export type CncWorkerJobArtworkItem = {
  /** Uploaded asset the worker fetches from `/api/cnc/worker/assets/:assetId`. Null for a text label. */
  assetId: string | null;
  /**
   * The asset's content type.
   *
   * Always null until PR 7 adds `cnc_art_assets`; there is nowhere to read a
   * mime from yet. Sent anyway so the field exists in v1 of the contract and
   * the worker does not have to change shape when it starts arriving.
   */
  mime: string | null;
  /** The label to route. Null for an uploaded asset. */
  text: string | null;
  mode: string;
  placement: Record<string, unknown> | null;
};

export type CncWorkerJob = {
  orderId: number;
  licenceId: string;
  /** Proof of lease. Every report the worker makes about this job carries it back. */
  claimToken: string;
  /** Bumped by an admin regenerate. Same licence and same output key. */
  generation: number;
  /** Which attempt this is, 1-based, counting reclaims of a dead lease. */
  attempt: number;
  tier: CncOrder['tier'];
  licensee: {
    name: string | null;
    email: string | null;
    /** The installation a commercial_single licence names. Null for personal. */
    customerSiteName: string | null;
  };
  config: {
    boardName: string;
    layoutId: number;
    sizeId: number;
    /** Parsed, not the comma-joined string — the generator wants numbers. */
    setIds: number[];
    options: CncOrderOptions;
    artwork: CncWorkerJobArtworkItem[];
  };
  /** Which catalogue produced `config.options`. Recorded so a rebuild is reproducible. */
  catalogVersion: string;
  /** Exactly what `POST /layout` takes. */
  layoutRequest: CncWorkerLayoutRequest;
  output: {
    engrave: {
      holdIds: boolean;
      angleTicks: boolean;
    };
    dxfFlavour: string;
    paper: string;
  };
  /** Where the zip must be written. Boardsesh dictates the key; the worker never invents one. */
  outputKey: string;
  /** The private bucket that key lives in. */
  bucket: string;
  issuedAt: string;
};

/**
 * Where an order's pack is stored.
 *
 * `anon` covers the one case where `user_id` is null: the account was deleted.
 * The licence outlives it (`onDelete: 'set null'`), so the pack has to keep a
 * stable key rather than move — a regenerate writes to the same place, which is
 * what makes a regenerated pack replace the old one instead of leaking a second
 * copy of a licensed file.
 */
export function cncPackOutputKey(order: Pick<CncOrder, 'userId' | 'licenceId'>): string {
  return `cnc-packs/${order.userId ?? 'anon'}/${order.licenceId}.zip`;
}

/** Read a boolean option. Anything that is not an explicit `true` is off — the engrave gates fail closed. */
function optionFlag(options: CncOrderOptions, key: string): boolean {
  return options[key] === true;
}

/** Read a string option, or throw: the generator has no default to fall back on. */
function optionString(options: CncOrderOptions, key: string): string {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CncJobPayloadError(`Order option "${key}" is missing or not a string`);
  }
  return value;
}

/** One stored artwork entry, as it was written at checkout. */
type StoredArtworkItem = {
  assetId?: unknown;
  text?: unknown;
  mode?: unknown;
  placement?: unknown;
};

function toJobArtwork(artwork: CncOrder['artwork']): CncWorkerJobArtworkItem[] {
  if (!Array.isArray(artwork)) return [];
  return artwork.map((raw) => {
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as StoredArtworkItem;
    return {
      assetId: typeof item.assetId === 'string' ? item.assetId : null,
      // TODO(PR 7): read the mime off `cnc_art_assets` once that table exists.
      mime: null,
      text: typeof item.text === 'string' ? item.text : null,
      mode: typeof item.mode === 'string' ? item.mode : 'engrave',
      placement:
        typeof item.placement === 'object' && item.placement !== null
          ? (item.placement as Record<string, unknown>)
          : null,
    };
  });
}

/**
 * Turn a claimed order into the job the worker runs.
 *
 * Throws `CncJobPayloadError` for an order that cannot produce one — no claim
 * token, unparseable set ids, an option the generator's request shape has no
 * slot for. None of those get better on a retry, so the caller fails the order
 * outright rather than handing it back to the queue to fail identically twice
 * more.
 */
export type BuildWorkerJobContext = {
  /** The private bucket's real name, resolved by the caller so this module stays free of storage config. */
  bucket: string;
  issuedAt: Date;
};

export function buildWorkerJob(order: CncOrder, { bucket, issuedAt }: BuildWorkerJobContext): CncWorkerJob {
  if (!order.claimToken) {
    throw new CncJobPayloadError('Claimed order has no claim token');
  }

  const setIds = parseSetIds(order.setIds);
  if (!setIds) {
    throw new CncJobPayloadError(`Order set ids "${order.setIds}" are not a valid set id list`);
  }

  // The order's own tuple, not a catalogue lookup: a retired entry must not
  // strand a paid pack. `toLayoutRequest` throws CncConfigMappingError for an
  // option it cannot map, which the caller treats the same way as this error.
  const layoutRequest = toLayoutRequest({
    entry: { boardName: order.boardName, layoutId: order.layoutId, sizeId: order.sizeId },
    options: order.options,
    setIds,
  });

  return {
    orderId: order.id,
    licenceId: order.licenceId,
    claimToken: order.claimToken,
    generation: order.generation,
    attempt: order.attempts,
    tier: order.tier,
    licensee: {
      name: order.licenseeName,
      email: order.licenseeEmail,
      customerSiteName: order.customerSiteName,
    },
    config: {
      boardName: order.boardName,
      layoutId: order.layoutId,
      sizeId: order.sizeId,
      setIds,
      options: order.options,
      artwork: toJobArtwork(order.artwork),
    },
    catalogVersion: order.catalogVersion,
    layoutRequest,
    output: {
      engrave: {
        holdIds: optionFlag(order.options, 'engraveHoldIds'),
        angleTicks: optionFlag(order.options, 'engraveAngleTicks'),
      },
      dxfFlavour: optionString(order.options, 'dxfFlavour'),
      paper: optionString(order.options, 'paper'),
    },
    outputKey: cncPackOutputKey(order),
    bucket,
    issuedAt: issuedAt.toISOString(),
  };
}
