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

/**
 * Where one artwork item sits, in wall millimetres.
 *
 * Every field is required and every field is a real number. The generator has
 * no defaults for any of them — a missing `xMm` is not "route it at zero", it
 * is a router head that does not know where to go — so an incomplete placement
 * is caught here rather than becoming a pack nobody can cut.
 */
export type CncWorkerJobPlacement = {
  panelIndex: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  rotationDeg: number;
};

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
  /**
   * The face the label is routed in, when one was stored with the item. Null
   * means the generator picks its own default — which is the right answer for
   * an uploaded asset, where there is no text to set.
   */
  font: string | null;
  mode: string;
  placement: CncWorkerJobPlacement;
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
    /**
     * Never null: it is printed on every sheet in the pack, so a job without
     * one has nothing to license and is refused at build time.
     */
    name: string;
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
  font?: unknown;
  mode?: unknown;
  placement?: unknown;
};

/** The five placement numbers, in the order they are reported when one is missing. */
const PLACEMENT_FIELDS = ['panelIndex', 'xMm', 'yMm', 'widthMm', 'rotationDeg'] as const;

/**
 * Read a stored placement, or throw.
 *
 * `artwork` is a JSON column: it was validated by zod at checkout, but that was
 * a different process on a different day and nothing in the database enforces
 * the shape. A half-written placement — an editor bug, a hand-edited row, a
 * migration that reshaped the column — used to sail through as
 * `Record<string, unknown>` and reach the generator, which would either crash
 * mid-job (three attempts, three identical crashes) or route the item
 * somewhere nobody asked for. Both are worse than refusing the job.
 */
function toJobPlacement(raw: unknown, index: number): CncWorkerJobPlacement {
  if (typeof raw !== 'object' || raw === null) {
    throw new CncJobPayloadError(`Artwork item ${String(index)} has no placement`);
  }
  const stored = raw as Record<string, unknown>;
  const placement = {} as Record<(typeof PLACEMENT_FIELDS)[number], number>;
  for (const field of PLACEMENT_FIELDS) {
    const value = stored[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CncJobPayloadError(`Artwork item ${String(index)} placement is missing a finite "${field}"`);
    }
    placement[field] = value;
  }
  return placement;
}

function toJobArtwork(artwork: CncOrder['artwork']): CncWorkerJobArtworkItem[] {
  if (!Array.isArray(artwork)) return [];
  return artwork.map((raw, index) => {
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as StoredArtworkItem;
    return {
      assetId: typeof item.assetId === 'string' ? item.assetId : null,
      // TODO(PR 7): read the mime off `cnc_art_assets` once that table exists.
      mime: null,
      text: typeof item.text === 'string' ? item.text : null,
      // Passed through when the buyer picked one; the generator falls back to
      // its own default rather than us inventing a face name here.
      font: typeof item.font === 'string' && item.font.length > 0 ? item.font : null,
      mode: typeof item.mode === 'string' ? item.mode : 'engrave',
      placement: toJobPlacement(item.placement, index),
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

  // The licensee name is printed on every sheet in the pack. Generating one
  // that says "undefined" across the title block is worse than not generating
  // it: the buyer would have to notice, and a licence with no name on it is
  // not a licence. Checkout requires the field, so an order without one is a
  // data problem an operator has to look at, which is exactly what failing the
  // order and mailing them does.
  const licenseeName = order.licenseeName?.trim();
  if (!licenseeName) {
    throw new CncJobPayloadError('Order has no licensee name to print on the pack');
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
      name: licenseeName,
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
