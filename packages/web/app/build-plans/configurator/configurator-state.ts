import type {
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
      };
    }
    case 'setKicker':
      return { ...state, includeKicker: action.includeKicker };
    case 'setOption':
      return { ...state, options: { ...state.options, [action.key]: action.value } };
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

  return {
    boardName: entry.boardName,
    layoutId: entry.layoutId,
    sizeId: entry.sizeId,
    setIds: setIdsFor(entry, state.includeKicker),
    options,
  };
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
