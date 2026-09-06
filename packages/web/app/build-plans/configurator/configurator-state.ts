import type {
  CncArtworkInput,
  CncArtworkMode,
  CncArtworkRules,
  CncBoardConfigInput,
  CncCatalogEntry,
  CncLicenceTier,
  CncManufacturingOption,
} from '@boardsesh/shared-schema';

/**
 * Everything the configurator knows, and every pure function that reads it.
 *
 * Deliberately free of React, MUI, GraphQL and the browser: the reducer and the
 * mapping to a checkout input are where a mistake costs someone money, so they
 * are unit-testable without mounting anything. `configurator.tsx` holds the
 * hooks and the markup and nothing else.
 */

/**
 * Set ids for the Kilter Homewall's removable kicker panels.
 *
 * RESTATED from `CNC_KICKER_SET_IDS` in
 * packages/backend/src/services/cnc/catalog.ts, not imported: a web module must
 * not reach into the backend package. The backend stays the authority — it
 * re-validates the submitted set ids on every checkout and rejects a half
 * kicker — so the worst a drift here can do is offer a toggle the server then
 * refuses, never sell a wall that is not what was configured.
 */
export const CNC_KICKER_SET_IDS: readonly number[] = [28, 29];

/**
 * The two manufacturing options that are engraving decisions rather than
 * machining ones.
 *
 * They live in the catalogue's `manufacturingOptions` like everything else, but
 * they get their own step in the UI: both are Kilter-specific, both are off
 * pending the IP review, and burying them among sheet sizes and hole diameters
 * would have people flipping them without reading why they are off.
 */
export const CNC_ENGRAVE_OPTION_KEYS: readonly string[] = ['engraveHoldIds', 'engraveAngleTicks'];

/** IndexedDB key the in-progress configuration is parked under across a sign-in round trip. */
export const CNC_CONFIGURATOR_DRAFT_KEY = 'cnc:configurator-draft';

/**
 * How a piece of artwork is cut, in the order the picker offers them.
 *
 * RESTATED from the `CncArtworkMode` enum rather than derived from it: an enum
 * gives no ordering, and the list has to open on the safest option. `engrave`
 * only scores the surface, `pocket` clears it to a depth, `cut_through` takes a
 * hole out of a structural panel — so that is the order, and the first entry is
 * the default.
 */
export const CNC_ARTWORK_MODES: readonly CncArtworkMode[] = ['engrave', 'pocket', 'cut_through'];

/**
 * One piece of artwork while the buyer is still placing it.
 *
 * Flatter than the `CncArtworkInput` it becomes: the placement is spread across
 * the top level so a form field maps to one key, and there is a local `id` a
 * React list can key on. Reordering or deleting an item must not make the row
 * above it re-render as a different item, which is exactly what an array index
 * as a key would do while somebody is typing in one.
 *
 * `text` is a string rather than `string | null` because it is bound to a text
 * field, and an empty one is "not filled in yet", not "no label". That
 * difference is why an empty item is dropped on the way out rather than sent as
 * an artwork item with nothing to route.
 */
export type CncArtworkDraft = {
  /** Local list key only. Never sent, never persisted as meaningful. */
  id: string;
  text: string;
  font: string;
  mode: CncArtworkMode;
  panelIndex: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  rotationDeg: number;
};

/**
 * Rotation bounds, restated from `CncPlacementInput`'s own contract.
 *
 * Signed rather than 0..360 so the value the buyer sees is the value the
 * server stores — the backend rejects anything outside this rather than
 * normalising it, so a UI that let someone type 270 would be building a
 * rejection.
 */
export const CNC_MIN_ROTATION_DEG = -180;
export const CNC_MAX_ROTATION_DEG = 180;

/**
 * The face used if the catalogue ever publishes none.
 *
 * Mirrors the generator's own default. Never a substitute for a face the buyer
 * chose — the generator rejects an unbundled font rather than swapping it — so
 * this only ever fills an empty select.
 */
export const CNC_FALLBACK_ARTWORK_FONT = 'liberation-sans';

export type CncConfiguratorState = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  /** Only ever true for a size whose catalogue entry says `kickerOptional`. */
  includeKicker: boolean;
  /**
   * Chosen manufacturing values, in the STRING form the catalogue publishes
   * them in. Coerced back to their real type by `valueType` on the way out —
   * see `toBoardConfigInput`. Keeping one representation in state means a
   * `<select>` value, a draft on disk and a comparison against `values[]` are
   * all the same string, with no place for `18` and `'18'` to disagree.
   */
  options: Record<string, string>;
  /** Artwork the buyer has placed, in the order they added it. At most `artworkRules.maxItems`. */
  artwork: CncArtworkDraft[];
  tier: CncLicenceTier;
  licenseeName: string;
  licenseeEmail: string;
  customerSiteName: string;
  licenceAccepted: boolean;
};

export type CncConfiguratorAction =
  | { type: 'selectSize'; entry: CncCatalogEntry }
  | { type: 'setKicker'; includeKicker: boolean }
  | { type: 'setOption'; key: string; value: string }
  | { type: 'addArtwork'; item: CncArtworkDraft }
  | { type: 'updateArtwork'; id: string; patch: Partial<Omit<CncArtworkDraft, 'id'>> }
  | { type: 'removeArtwork'; id: string }
  | { type: 'setTier'; tier: CncLicenceTier }
  | { type: 'setLicenseeName'; value: string }
  | { type: 'setLicenseeEmail'; value: string }
  | { type: 'setCustomerSiteName'; value: string }
  | { type: 'setLicenceAccepted'; accepted: boolean }
  | { type: 'restoreDraft'; state: CncConfiguratorState };

/** Default values for every option a catalogue entry publishes, as strings. */
export function defaultOptions(entry: CncCatalogEntry): Record<string, string> {
  const options: Record<string, string> = {};
  for (const option of entry.manufacturingOptions) {
    options[option.key] = option.defaultValue;
  }
  return options;
}

/** The configurator's opening position: the first entry on sale, at its defaults. */
export function initialConfiguratorState(entry: CncCatalogEntry): CncConfiguratorState {
  return {
    boardName: entry.boardName,
    layoutId: entry.layoutId,
    sizeId: entry.sizeId,
    // A kicker is opt-OUT, not opt-in: the walls that have one are almost
    // always built with it, and a buyer who did not notice the toggle gets the
    // wall they expected rather than a pack missing its bottom row.
    includeKicker: entry.kickerOptional,
    options: defaultOptions(entry),
    // No artwork by default. Most packs carry none, and an empty slot the buyer
    // has to notice and delete is worse than a button they never press.
    artwork: [],
    tier: 'personal',
    licenseeName: '',
    licenseeEmail: '',
    customerSiteName: '',
    licenceAccepted: false,
  };
}

export function findEntry(entries: readonly CncCatalogEntry[], state: CncConfiguratorState): CncCatalogEntry | null {
  return (
    entries.find(
      (entry) =>
        entry.boardName === state.boardName && entry.layoutId === state.layoutId && entry.sizeId === state.sizeId,
    ) ?? null
  );
}

export function configuratorReducer(state: CncConfiguratorState, action: CncConfiguratorAction): CncConfiguratorState {
  switch (action.type) {
    case 'selectSize': {
      // Options are reset to the new entry's defaults rather than carried over.
      // Two entries can publish different option sets, and a value carried onto
      // a size that does not allow it is a checkout the backend rejects with an
      // error the buyer cannot act on. Who they are and which licence they
      // picked survive — those are about the buyer, not the wall.
      return {
        ...state,
        boardName: action.entry.boardName,
        layoutId: action.entry.layoutId,
        sizeId: action.entry.sizeId,
        includeKicker: action.entry.kickerOptional,
        options: defaultOptions(action.entry),
        // Artwork goes with the options, and for a sharper reason: a placement
        // names a PANEL INDEX and a millimetre position on a specific wall.
        // Carried onto another size those numbers point somewhere else
        // entirely — most likely off the panel, which is a checkout the
        // generator refuses with a collision the buyer never caused.
        artwork: [],
      };
    }
    case 'setKicker':
      return { ...state, includeKicker: action.includeKicker };
    case 'setOption':
      return { ...state, options: { ...state.options, [action.key]: action.value } };
    case 'addArtwork':
      return { ...state, artwork: [...state.artwork, action.item] };
    case 'updateArtwork':
      return {
        ...state,
        artwork: state.artwork.map((item) => (item.id === action.id ? { ...item, ...action.patch } : item)),
      };
    case 'removeArtwork':
      return { ...state, artwork: state.artwork.filter((item) => item.id !== action.id) };
    case 'setTier':
      // Dropping back to personal clears the site name: it is meaningless on a
      // personal licence, and the backend rejects a personal order that carries
      // one rather than ignoring it.
      return {
        ...state,
        tier: action.tier,
        customerSiteName: action.tier === 'commercial_single' ? state.customerSiteName : '',
      };
    case 'setLicenseeName':
      return { ...state, licenseeName: action.value };
    case 'setLicenseeEmail':
      return { ...state, licenseeEmail: action.value };
    case 'setCustomerSiteName':
      return { ...state, customerSiteName: action.value };
    case 'setLicenceAccepted':
      // Acceptance is never restored, only given: see `fromDraft`.
      return { ...state, licenceAccepted: action.accepted };
    case 'restoreDraft':
      return action.state;
  }
}

/**
 * The machining options to show, in catalogue order.
 *
 * Two exclusions. `kickerOnly` options disappear when no kicker is being built,
 * because a mat clearance on a wall with nothing to clear is a control that
 * changes nothing in the pack. The engrave options are pulled out into their
 * own step (see `CNC_ENGRAVE_OPTION_KEYS`).
 */
export function visibleMachiningOptions(
  entry: CncCatalogEntry,
  includeKicker: boolean,
): readonly CncManufacturingOption[] {
  return entry.manufacturingOptions.filter(
    (option) => !CNC_ENGRAVE_OPTION_KEYS.includes(option.key) && (includeKicker || !option.kickerOnly),
  );
}

/** The engrave toggles, in catalogue order. Empty when the entry publishes none. */
export function engraveOptions(entry: CncCatalogEntry): readonly CncManufacturingOption[] {
  return entry.manufacturingOptions.filter((option) => CNC_ENGRAVE_OPTION_KEYS.includes(option.key));
}

/**
 * An option value as an i18n key segment.
 *
 * Catalogue values carry characters i18next reads structurally: `12.5` would
 * nest a `12` object with a `5` inside it. Dots become underscores, and
 * anything else outside `[A-Za-z0-9_-]` goes the same way, so `12.5` is
 * `12_5` and `101.6` is `101_6`. The catalogs are written against this
 * function; changing it renames every value key.
 */
export function optionValueKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Comma-joined set ids for the wall as configured, kicker in or out. */
export function setIdsFor(entry: CncCatalogEntry, includeKicker: boolean): string {
  const setIds = entry.setIds
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (includeKicker) {
    return setIds.join(',');
  }
  return setIds.filter((setId) => !CNC_KICKER_SET_IDS.includes(Number(setId))).join(',');
}

/** Whether this entry's set list actually contains kicker sets to drop. */
export function hasKickerSets(entry: CncCatalogEntry): boolean {
  return entry.setIds.split(',').some((segment) => CNC_KICKER_SET_IDS.includes(Number(segment.trim())));
}

/**
 * Read a stored string back as the type the catalogue holds it as.
 *
 * `valueType` is `typeof` the catalogue's own default, so it is exactly one of
 * `'boolean'`, `'number'` or `'string'`. Anything unparseable falls through as
 * the string, which the backend's own matcher then rejects by value — better a
 * named validation error than a silent `NaN` in a machining dimension.
 */
export function coerceOptionValue(raw: string, valueType: string): string | number | boolean {
  if (valueType === 'boolean') return raw === 'true';
  if (valueType === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

/**
 * The configuration as the GraphQL input the layout preview, artwork validation
 * and checkout all take. One mapping, so a preview can never disagree with what
 * is bought.
 *
 * Only options the entry still publishes are sent, and each is coerced by its
 * own `valueType`. A key left over in state from a previous size is dropped
 * rather than forwarded — the backend rejects unknown option keys outright.
 */
export function toBoardConfigInput(state: CncConfiguratorState, entry: CncCatalogEntry): CncBoardConfigInput {
  const options: Record<string, string | number | boolean> = {};
  for (const option of entry.manufacturingOptions) {
    const raw = state.options[option.key] ?? option.defaultValue;
    options[option.key] = coerceOptionValue(raw, option.valueType);
  }

  const artworkInputs = toArtworkInputs(state.artwork);

  return {
    boardName: entry.boardName,
    layoutId: entry.layoutId,
    sizeId: entry.sizeId,
    setIds: setIdsFor(entry, state.includeKicker),
    options,
    // Undefined rather than an empty array when there is nothing to route:
    // checkout skips the generator round trip entirely for an order with no
    // artwork, and an empty list would still look like "the buyer placed
    // something" to every reader of the input.
    ...(artworkInputs.length > 0 ? { artwork: artworkInputs } : {}),
  };
}

/**
 * A draft item that is finished enough to send.
 *
 * An item with no text yet is the buyer mid-typing, not an item they want
 * routed — sending it would fail validation on a field they have not reached.
 * Everything else about an item is always set: the numbers come from controls
 * with defaults, so there is no half-filled placement to guard against.
 */
export function isArtworkReady(item: CncArtworkDraft): boolean {
  return item.text.trim().length > 0;
}

/**
 * The artwork as the GraphQL input takes it.
 *
 * The local `id` is dropped and the placement is re-nested. Items with no text
 * are dropped rather than sent — see `isArtworkReady`.
 */
export function toArtworkInputs(artwork: readonly CncArtworkDraft[]): CncArtworkInput[] {
  return artwork.filter(isArtworkReady).map((item) => ({
    text: item.text.trim(),
    font: item.font,
    mode: item.mode,
    placement: {
      panelIndex: item.panelIndex,
      xMm: item.xMm,
      yMm: item.yMm,
      widthMm: item.widthMm,
      rotationDeg: item.rotationDeg,
    },
  }));
}

/** Why one artwork item cannot be sent yet. Each value is an i18n key segment under `configurator.artwork.issues`. */
export type CncArtworkIssue = 'text' | 'textTooLong' | 'width' | 'rotation';

/**
 * Everything wrong with one item, in the order its fields appear.
 *
 * Local mirrors of the server's own bounds, so a buyer sees "that is too wide"
 * as they drag the slider rather than as a rejected checkout. The server is
 * still the authority — these numbers come from `CncCatalog.artworkRules`,
 * which is published from the constants that enforce them.
 */
export function artworkIssues(item: CncArtworkDraft, rules: CncArtworkRules): CncArtworkIssue[] {
  const issues: CncArtworkIssue[] = [];
  const text = item.text.trim();
  if (text.length === 0) issues.push('text');
  else if (text.length > rules.maxTextChars) issues.push('textTooLong');
  if (!Number.isFinite(item.widthMm) || item.widthMm < rules.minWidthMm || item.widthMm > rules.maxWidthMm) {
    issues.push('width');
  }
  if (
    !Number.isFinite(item.rotationDeg) ||
    item.rotationDeg < CNC_MIN_ROTATION_DEG ||
    item.rotationDeg > CNC_MAX_ROTATION_DEG
  ) {
    issues.push('rotation');
  }
  return issues;
}

/** True when every placed item is within the local bounds. Vacuously true with no artwork. */
export function isArtworkLocallyValid(artwork: readonly CncArtworkDraft[], rules: CncArtworkRules): boolean {
  return artwork.every((item) => artworkIssues(item, rules).length === 0);
}

/**
 * A new item, centred on the panel the buyer is looking at.
 *
 * Starts at the narrow end of the allowed range rather than in the middle: a
 * small label is far more likely to land somewhere legal on a wall already full
 * of T-nut keep-outs, so the first thing the buyer sees is usually a valid
 * placement they can then grow.
 */
export function newArtworkItem({
  rules,
  font,
  panelIndex = 0,
  id = createArtworkId(),
}: {
  rules: CncArtworkRules;
  /** The catalogue's first font, which is its default. */
  font: string;
  panelIndex?: number;
  id?: string;
}): CncArtworkDraft {
  return {
    id,
    text: '',
    font,
    mode: CNC_ARTWORK_MODES[0],
    panelIndex,
    xMm: 0,
    yMm: 0,
    widthMm: rules.minWidthMm,
    rotationDeg: 0,
  };
}

/** A list key. `crypto.randomUUID` where it exists, a counter where it does not (older Safari, jsdom). */
let artworkIdCounter = 0;
export function createArtworkId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  artworkIdCounter += 1;
  return `artwork-${String(artworkIdCounter)}`;
}

/** Why Buy is disabled, in the order the fields appear. Empty means buyable. */
export type CncCheckoutBlocker = 'licenseeName' | 'licenseeEmail' | 'customerSiteName' | 'licenceAccepted';

export function checkoutBlockers(state: CncConfiguratorState): CncCheckoutBlocker[] {
  const blockers: CncCheckoutBlocker[] = [];
  if (state.licenseeName.trim().length === 0) blockers.push('licenseeName');
  // Deliberately the loosest possible check — a local part, an @, a dot in the
  // domain. The address is confirmed by the pack landing in it, and a stricter
  // regex here only ever rejects somebody's real address.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.licenseeEmail.trim())) blockers.push('licenseeEmail');
  if (state.tier === 'commercial_single' && state.customerSiteName.trim().length === 0) {
    blockers.push('customerSiteName');
  }
  if (!state.licenceAccepted) blockers.push('licenceAccepted');
  return blockers;
}

/**
 * What gets written to IndexedDB so a sign-in round trip does not throw the
 * configuration away.
 *
 * `licenceAccepted` is NOT in the draft, on purpose. Acceptance is an act, and
 * restoring it would let a browser that once ticked the box arrive at checkout
 * pre-accepted without anyone having read anything. The email is kept: it is
 * the buyer's own, typed by them, in their own browser.
 */
export type CncConfiguratorDraft = Omit<CncConfiguratorState, 'licenceAccepted'>;

export function toDraft(state: CncConfiguratorState): CncConfiguratorDraft {
  const { licenceAccepted: _accepted, ...draft } = state;
  return draft;
}

/**
 * Rebuild the artwork list from a stored draft.
 *
 * Every field is re-checked, and an item that fails any check is DROPPED rather
 * than repaired. A placement is five numbers that only mean anything together —
 * a repaired one would put the buyer's label somewhere they never chose, on a
 * wall they are about to pay for. Losing the item is visible; silently moving
 * it is not.
 *
 * Bounds are deliberately not checked here. They come from the catalogue, which
 * this function does not have, and the live `artworkIssues` check reports an
 * out-of-range value as something to fix rather than hiding it.
 */
function readDraftArtwork(raw: unknown): CncArtworkDraft[] {
  if (!Array.isArray(raw)) return [];

  const items: CncArtworkDraft[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const numbers = ['panelIndex', 'xMm', 'yMm', 'widthMm', 'rotationDeg'] as const;
    if (
      typeof item.text !== 'string' ||
      typeof item.font !== 'string' ||
      typeof item.mode !== 'string' ||
      !CNC_ARTWORK_MODES.includes(item.mode as CncArtworkMode) ||
      numbers.some((field) => typeof item[field] !== 'number' || !Number.isFinite(item[field]))
    ) {
      continue;
    }
    items.push({
      // A stored id is only ever a React list key, so a draft missing one gets
      // a fresh one rather than being thrown away.
      id: typeof item.id === 'string' && item.id.length > 0 ? item.id : createArtworkId(),
      text: item.text,
      font: item.font,
      mode: item.mode as CncArtworkMode,
      panelIndex: item.panelIndex as number,
      xMm: item.xMm as number,
      yMm: item.yMm as number,
      widthMm: item.widthMm as number,
      rotationDeg: item.rotationDeg as number,
    });
  }
  return items;
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

/**
 * Rebuild state from a stored draft, or return null.
 *
 * Everything is re-checked against the CURRENT catalogue rather than trusted:
 * a draft can be weeks old, and a size that has been retired or an option value
 * that has been dropped would otherwise come back as a configuration the buyer
 * can see but not buy. A stale option value falls back to today's default; a
 * stale board tuple discards the draft entirely.
 */
export function fromDraft(raw: unknown, entries: readonly CncCatalogEntry[]): CncConfiguratorState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const draft = raw as Record<string, unknown>;

  if (
    typeof draft.boardName !== 'string' ||
    typeof draft.layoutId !== 'number' ||
    typeof draft.sizeId !== 'number' ||
    typeof draft.includeKicker !== 'boolean' ||
    typeof draft.licenseeName !== 'string' ||
    typeof draft.licenseeEmail !== 'string' ||
    typeof draft.customerSiteName !== 'string' ||
    (draft.tier !== 'personal' && draft.tier !== 'commercial_single') ||
    !isRecordOfStrings(draft.options)
  ) {
    return null;
  }

  const entry = entries.find(
    (candidate) =>
      candidate.boardName === draft.boardName &&
      candidate.layoutId === draft.layoutId &&
      candidate.sizeId === draft.sizeId,
  );
  if (!entry) return null;

  const options: Record<string, string> = {};
  for (const option of entry.manufacturingOptions) {
    const stored = draft.options[option.key];
    options[option.key] = stored !== undefined && option.values.includes(stored) ? stored : option.defaultValue;
  }

  return {
    boardName: entry.boardName,
    layoutId: entry.layoutId,
    sizeId: entry.sizeId,
    includeKicker: entry.kickerOptional && draft.includeKicker,
    options,
    artwork: readDraftArtwork(draft.artwork),
    tier: draft.tier,
    licenseeName: draft.licenseeName,
    licenseeEmail: draft.licenseeEmail,
    customerSiteName: draft.tier === 'commercial_single' ? draft.customerSiteName : '',
    licenceAccepted: false,
  };
}

/** The price the chosen tier is on sale for, or null when the entry has no such tier. */
export function tierPrice(
  entry: CncCatalogEntry,
  tier: CncLicenceTier,
): { amountCents: number; currency: string } | null {
  const price = entry.tiers.find((candidate) => candidate.tier === tier);
  return price ? { amountCents: price.amountCents, currency: price.currency } : null;
}

/** Money as the locale writes it. Cents in, "A$149.00" out. */
export function formatPrice(amountCents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountCents / 100);
}
