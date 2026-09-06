import type { BoardName } from '@boardsesh/shared-schema';
import { getSetsForLayoutAndSize, KILTER_HOMEWALL_LAYOUT_ID } from '@boardsesh/board-constants';
import type { CncOrderOptions } from '@boardsesh/db/schema';

/**
 * What Boardsesh will sell a CNC build pack for, and which manufacturing
 * choices the buyer may make.
 *
 * This registry is the single gate between a URL tuple and a purchasable pack:
 * checkout, the layout preview and the generator job all resolve through
 * `findCatalogEntry`, so a board/size that is not listed here cannot be bought
 * and cannot reach the worker.
 *
 * Bumped whenever an entry, an allowed value or a default changes. Every order
 * stores the version it was priced and configured under, so a regenerate months
 * later rebuilds the pack the buyer paid for rather than today's defaults.
 */
export const CNC_CATALOG_VERSION = '2026-09-06.1';

export type CncLicenceTier = 'personal' | 'commercial_single';

/** JSON-scalar values a manufacturing option can take. */
export type CncManufacturingOptionValue = string | number | boolean;

export type CncManufacturingOption = {
  key: string;
  /** The complete allowed set. Anything outside it is rejected, not clamped. */
  values: readonly CncManufacturingOptionValue[];
  defaultValue: CncManufacturingOptionValue;
  /**
   * True when this option only means anything on a wall that is actually
   * building a kicker. The web configurator hides it for a kickerless wall
   * (or one where the buyer left the kicker off) instead of showing a
   * clearance the pack will never cut.
   */
  kickerOnly: boolean;
};

export type CncTierPrice = {
  tier: CncLicenceTier;
  priceCents: number;
  currency: 'AUD';
  /** Env var holding the Stripe Price id. Prices live in Stripe, ids never in the repo. */
  stripePriceEnv: string;
};

export type CncCatalogEntry = {
  boardName: BoardName;
  layoutId: number;
  /** The canonical size id. Aliases resolve to this one before anything else runs. */
  sizeId: number;
  /** Comma-joined set ids, same shape as the `[set_ids]` URL segment. */
  setIds: string;
  label: string;
  /**
   * Size ids that describe the same physical wall as `sizeId` and differ only
   * in which LED kit Aurora sells with it (Mainline-only, Auxiliary-only). The
   * panels are identical, so they all buy the same pack.
   */
  sizeAliases: readonly number[];
  /** True when this size has kicker sets (28/29) the buyer can include or leave off. */
  kickerOptional: boolean;
  manufacturingOptions: readonly CncManufacturingOption[];
  tiers: readonly CncTierPrice[];
};

/**
 * Manufacturing options, identical for every Kilter Homewall size.
 *
 * Values are enumerations rather than ranges on purpose: the generator has a
 * golden test per combination, and a free-form millimetre field would let a
 * buyer order a pack no one has ever cut. Widening a list means adding goldens
 * and bumping CNC_CATALOG_VERSION.
 */
const KILTER_HOMEWALL_MANUFACTURING_OPTIONS: readonly CncManufacturingOption[] = [
  // Standard AU sheet, plus the 3.6 m sheet that lets a 10 ft wall row be cut
  // without a seam.
  { key: 'sheetStock', values: ['2440x1220', '3600x1220'], defaultValue: '2440x1220', kickerOnly: false },
  { key: 'panelThicknessMm', values: [15, 18, 21], defaultValue: 18, kickerOnly: false },
  // 12.5 mm suits the common M10 T-nut barrel; the others cover the sizes sold
  // in other markets.
  { key: 'tnutHoleDiameterMm', values: [11.1, 12, 12.5, 13], defaultValue: 12.5, kickerOnly: false },
  { key: 'ledHoleDiameterMm', values: [8, 10, 12.5, 12.7], defaultValue: 12.5, kickerOnly: false },
  // How much clearance the kicker leaves above the mat — meaningless on a
  // kickerless wall, which is why this is the one option flagged kicker-only.
  { key: 'kickerMatClearanceMm', values: [50, 75, 100], defaultValue: 50, kickerOnly: true },
  { key: 'studClearanceOffsetMm', values: [0, 30, 60], defaultValue: 60, kickerOnly: false },
  // 101.6 mm is exactly 4 inches; 100 mm is what the metric builds use.
  { key: 'gridPitchMm', values: [100, 101.6], defaultValue: 100, kickerOnly: false },
  // R12 writes native CIRCLE entities, which more machine controllers read as
  // drill points than R2010 polylines — hence the default.
  { key: 'dxfFlavour', values: ['R12_circles', 'R2010_polylines'], defaultValue: 'R12_circles', kickerOnly: false },
  { key: 'paper', values: ['A3', 'TABLOID'], defaultValue: 'A3', kickerOnly: false },
  // Both engrave layers default off pending the IP review of the Kilter-derived
  // hold ids and set-screw angles.
  { key: 'engraveHoldIds', values: [false, true], defaultValue: false, kickerOnly: false },
  { key: 'engraveAngleTicks', values: [false, true], defaultValue: false, kickerOnly: false },
];

const KILTER_HOMEWALL_TIERS: readonly CncTierPrice[] = [
  { tier: 'personal', priceCents: 14900, currency: 'AUD', stripePriceEnv: 'STRIPE_PRICE_CNC_PERSONAL' },
  { tier: 'commercial_single', priceCents: 75000, currency: 'AUD', stripePriceEnv: 'STRIPE_PRICE_CNC_COMMERCIAL' },
];

type KilterHomewallSize = {
  sizeId: number;
  label: string;
  sizeAliases: readonly number[];
  kickerOptional: boolean;
};

/**
 * The four Kilter Homewall walls, keyed on the Full Ride size id.
 *
 * Aliases: 18/19 are the 7x10 Mainline / Auxiliary LED kits, 22/29 the 10x10
 * pair, 24 the 8x12 Mainline kit and 26 the 10x12 Mainline kit. Only the 12 ft
 * walls (23, 25) carry kicker sets, which is why `kickerOptional` is false for
 * the 10 ft ones — there is no kicker to opt out of.
 */
const KILTER_HOMEWALL_SIZES: readonly KilterHomewallSize[] = [
  { sizeId: 17, label: '7x10', sizeAliases: [18, 19], kickerOptional: false },
  { sizeId: 21, label: '10x10', sizeAliases: [22, 29], kickerOptional: false },
  { sizeId: 23, label: '8x12', sizeAliases: [24], kickerOptional: true },
  { sizeId: 25, label: '10x12', sizeAliases: [26], kickerOptional: true },
];

function defaultSetIdsFor(sizeId: number): string {
  const sets = getSetsForLayoutAndSize('kilter', KILTER_HOMEWALL_LAYOUT_ID, sizeId);
  if (sets.length === 0) {
    // A catalogue entry whose sets vanished would silently sell an empty wall,
    // so fail at module load rather than at generation time.
    throw new Error(`[cnc-catalog] no sets for kilter layout ${KILTER_HOMEWALL_LAYOUT_ID} size ${sizeId}`);
  }
  return sets.map((set) => set.id).join(',');
}

export const CNC_CATALOG: readonly CncCatalogEntry[] = KILTER_HOMEWALL_SIZES.map((size) => ({
  boardName: 'kilter' as BoardName,
  layoutId: KILTER_HOMEWALL_LAYOUT_ID,
  sizeId: size.sizeId,
  setIds: defaultSetIdsFor(size.sizeId),
  label: size.label,
  sizeAliases: size.sizeAliases,
  kickerOptional: size.kickerOptional,
  manufacturingOptions: KILTER_HOMEWALL_MANUFACTURING_OPTIONS,
  tiers: KILTER_HOMEWALL_TIERS,
}));

export type CncBoardTuple = {
  boardName: string;
  layoutId: number;
  sizeId: number;
};

/**
 * Resolve a board tuple to its catalogue entry, following size aliases.
 *
 * Returns null for anything not on sale — the caller turns that into a 404 or a
 * validation error, never into a default entry.
 */
export function findCatalogEntry({ boardName, layoutId, sizeId }: CncBoardTuple): CncCatalogEntry | null {
  return (
    CNC_CATALOG.find(
      (entry) =>
        entry.boardName === boardName &&
        entry.layoutId === layoutId &&
        (entry.sizeId === sizeId || entry.sizeAliases.includes(sizeId)),
    ) ?? null
  );
}

export type CncOptionValidationErrorCode = 'not_an_object' | 'unknown_option' | 'invalid_value';

export type CncOptionValidationError = {
  /** The offending option key, or '' when the whole payload is the problem. */
  key: string;
  code: CncOptionValidationErrorCode;
  message: string;
};

export type CncOptionValidationResult =
  | { ok: true; options: CncOrderOptions }
  | { ok: false; errors: CncOptionValidationError[] };

/**
 * Coerce one submitted value onto an allowed value, or return null.
 *
 * Form and JSON transports flatten types — a select sends "18" and "true" where
 * the catalogue holds 18 and true — so a submitted value is matched against the
 * allowed set by its string form as well as by identity. The value stored is
 * always the catalogue's own, so a downstream `=== 18` never has to guess.
 */
function matchAllowedValue(
  submitted: unknown,
  allowed: readonly CncManufacturingOptionValue[],
): CncManufacturingOptionValue | null {
  if (typeof submitted !== 'string' && typeof submitted !== 'number' && typeof submitted !== 'boolean') {
    return null;
  }
  const submittedText = String(submitted);
  return allowed.find((value) => String(value) === submittedText) ?? null;
}

/**
 * Check submitted manufacturing options against a catalogue entry and return
 * the full normalised set (every key present, defaults filled in).
 *
 * Every error is collected rather than thrown on the first one, so the
 * configurator can show all of them at once. Unknown keys are rejected instead
 * of dropped: silently ignoring an option the buyer set would hand them a pack
 * that is not what they configured.
 */
export function validateCatalogOptions(entry: CncCatalogEntry, options: unknown): CncOptionValidationResult {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return {
      ok: false,
      errors: [{ key: '', code: 'not_an_object', message: 'Manufacturing options must be an object.' }],
    };
  }

  const submittedOptions = options as Record<string, unknown>;
  const errors: CncOptionValidationError[] = [];
  const normalisedOptions: CncOrderOptions = {};

  const allowedKeys = new Set(entry.manufacturingOptions.map((option) => option.key));
  for (const submittedKey of Object.keys(submittedOptions)) {
    if (!allowedKeys.has(submittedKey)) {
      errors.push({
        key: submittedKey,
        code: 'unknown_option',
        message: `Unknown manufacturing option "${submittedKey}".`,
      });
    }
  }

  for (const option of entry.manufacturingOptions) {
    if (!(option.key in submittedOptions) || submittedOptions[option.key] === undefined) {
      normalisedOptions[option.key] = option.defaultValue;
      continue;
    }
    const matched = matchAllowedValue(submittedOptions[option.key], option.values);
    if (matched === null) {
      errors.push({
        key: option.key,
        code: 'invalid_value',
        message: `"${option.key}" must be one of: ${option.values.join(', ')}.`,
      });
      continue;
    }
    normalisedOptions[option.key] = matched;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, options: normalisedOptions };
}

/**
 * Parse a `[set_ids]` URL segment ("26,27") into set ids.
 *
 * Returns null for anything malformed — empty, non-numeric, negative or
 * duplicated — so a caller cannot accidentally treat a bad segment as "no
 * sets". Order is preserved; the segment is stored verbatim on the order.
 */
export function parseSetIds(setIds: string): number[] | null {
  const segments = setIds.split(',');
  const parsed: number[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const setId = Number.parseInt(trimmed, 10);
    if (parsed.includes(setId)) return null;
    parsed.push(setId);
  }
  return parsed.length > 0 ? parsed : null;
}

/**
 * Set ids for the removable kicker panel on the Kilter Homewall's 12 ft walls.
 *
 * board-constants has no notion of "kicker" as a first-class concept —
 * `getSetsForLayoutAndSize` returns every set for a size (Aurora names 28/29
 * "Mainline/Auxiliary Kickboard" in `generated/product-sizes-data.ts`, but
 * that is a display label, not something exported for matching against), so
 * there is no helper to derive this from. Pinned here as a named constant
 * instead of inlining `28`/`29` at the call site: see the
 * `sizeAliases`/`kickerOptional` comment on `KILTER_HOMEWALL_SIZES` above for
 * why only the 12 ft walls (23, 25) have a kicker to opt out of.
 */
const KICKER_SET_IDS: readonly number[] = [28, 29];

/**
 * Check a buyer's chosen set ids against a catalogue entry's full set list.
 *
 * Every submitted id must belong to the entry (buying a set from a different
 * size's wall makes no sense); a kicker set may be left off only when the
 * entry says the kicker is optional; anything else the entry lists is
 * required, since a pack missing a mainline panel is not the wall the buyer
 * thinks they are getting. Duplicates are rejected rather than deduped so a
 * malformed request fails loudly instead of silently halving a quantity.
 */
export function validateSetIds(
  entry: CncCatalogEntry,
  setIds: number[],
): { ok: true; setIds: number[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const allowedSetIds = new Set(parseSetIds(entry.setIds) ?? []);

  const submitted = new Set<number>();
  for (const setId of setIds) {
    if (submitted.has(setId)) {
      errors.push(`Set ${setId} was submitted more than once.`);
      continue;
    }
    submitted.add(setId);
    if (!allowedSetIds.has(setId)) {
      errors.push(`Set ${setId} is not part of this size's catalogue entry.`);
    }
  }

  for (const setId of allowedSetIds) {
    if (submitted.has(setId)) continue;
    const isOptionalKicker = KICKER_SET_IDS.includes(setId) && entry.kickerOptional;
    if (!isOptionalKicker) errors.push(`Set ${setId} is required for this size.`);
  }

  // A kicker is both panels or neither: one kicker set on its own would leave
  // the generator building half a kicker row.
  const chosenKickers = KICKER_SET_IDS.filter((setId) => submitted.has(setId));
  const availableKickers = KICKER_SET_IDS.filter((setId) => allowedSetIds.has(setId));
  if (chosenKickers.length > 0 && chosenKickers.length !== availableKickers.length) {
    errors.push('A kicker needs both of its sets, or neither.');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, setIds: [...submitted].sort((left, right) => left - right) };
}

/** Exported for the worker request mapper, which needs to know whether a kicker was chosen. */
export const CNC_KICKER_SET_IDS: readonly number[] = KICKER_SET_IDS;
