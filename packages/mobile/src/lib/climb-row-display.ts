// What a climb list row shows, as data: one boolean per optional piece of the
// row, the presets that set several at once, and the shape that is stored.
//
// Pure on purpose (no React, no storage). The store that persists a choice is
// `climb-row-display-preference.ts`; this file is everything it can decide
// without touching the phone, so the whole state machine is unit-tested here.
//
// Name, grade and the way into a climb are not in this list: they are fixed.

export const CLIMB_ROW_FIELD_IDS = [
  'thumbnail',
  'communityGrade',
  'sends',
  'rating',
  'setter',
  'sentMark',
  'progress',
  'playlistTags',
  'quickActions',
] as const;
export type ClimbRowFieldId = (typeof CLIMB_ROW_FIELD_IDS)[number];
export type ClimbRowDisplay = Readonly<Record<ClimbRowFieldId, boolean>>;

/** Today's row: everything but the playlist tags. */
export const DEFAULT_CLIMB_ROW_DISPLAY: ClimbRowDisplay = Object.freeze({
  thumbnail: true,
  communityGrade: true,
  sends: true,
  rating: true,
  setter: true,
  sentMark: true,
  progress: false,
  playlistTags: false,
  quickActions: true,
});

// Presets cover the CONTENT fields only. `quickActions` is how you open a
// climb's actions, not what the row shows, so a preset never touches it.
export type ClimbRowPresetFieldId = Exclude<ClimbRowFieldId, 'quickActions'>;
export type ClimbRowPresetFields = Readonly<Record<ClimbRowPresetFieldId, boolean>>;
export const CLIMB_ROW_PRESET_FIELD_IDS: readonly ClimbRowPresetFieldId[] = CLIMB_ROW_FIELD_IDS.filter(
  (fieldId): fieldId is ClimbRowPresetFieldId => fieldId !== 'quickActions',
);

export const CLIMB_ROW_PRESET_IDS = ['namesOnly', 'textOnly', 'default', 'everything'] as const;
export type ClimbRowPresetId = (typeof CLIMB_ROW_PRESET_IDS)[number];

// Every preset spells out every content field instead of spreading the default,
// so a field id added to the list above fails to compile here until each preset
// has decided about it.
export const CLIMB_ROW_PRESETS = {
  namesOnly: {
    thumbnail: false,
    communityGrade: false,
    sends: false,
    rating: false,
    setter: false,
    sentMark: true,
    progress: false,
    playlistTags: false,
  },
  textOnly: {
    thumbnail: false,
    communityGrade: true,
    sends: true,
    rating: true,
    setter: true,
    sentMark: true,
    progress: false,
    playlistTags: false,
  },
  default: {
    thumbnail: true,
    communityGrade: true,
    sends: true,
    rating: true,
    setter: true,
    sentMark: true,
    progress: false,
    playlistTags: false,
  },
  everything: {
    thumbnail: true,
    communityGrade: true,
    sends: true,
    rating: true,
    setter: true,
    sentMark: true,
    progress: true,
    playlistTags: true,
  },
} as const satisfies Record<ClimbRowPresetId, ClimbRowPresetFields>;

/**
 * The preset this row is, or `'custom'` when it is none of them. Derived by
 * comparing, never stored, so a field added later cannot strand anyone on a
 * preset name their row no longer matches. `quickActions` is not compared.
 */
export function matchClimbRowPreset(display: ClimbRowDisplay): ClimbRowPresetId | 'custom' {
  for (const presetId of CLIMB_ROW_PRESET_IDS) {
    const preset: ClimbRowPresetFields = CLIMB_ROW_PRESETS[presetId];
    if (CLIMB_ROW_PRESET_FIELD_IDS.every((fieldId) => preset[fieldId] === display[fieldId])) return presetId;
  }
  return 'custom';
}

/** Only what the climber changed. A field left out follows the shipped default. */
export type ClimbRowOverrides = Partial<Record<ClimbRowFieldId, boolean>>;

// The two switches that had an AsyncStorage key of their own before this record.
// Builds from before it still read and write those keys, and a phone can move
// between the two kinds of build in either direction (an OTA rollback; a tester
// leaving a preview), so the old keys and this record are kept in step, both ways.
export const CLIMB_ROW_LEGACY_FIELD_IDS = [
  'playlistTags',
  'quickActions',
] as const satisfies readonly ClimbRowFieldId[];
export type ClimbRowLegacyFieldId = (typeof CLIMB_ROW_LEGACY_FIELD_IDS)[number];

export function isClimbRowLegacyFieldId(fieldId: ClimbRowFieldId): fieldId is ClimbRowLegacyFieldId {
  return CLIMB_ROW_LEGACY_FIELD_IDS.some((legacyFieldId) => legacyFieldId === fieldId);
}

/**
 * What a build from before this record shows for an old key with no explicit
 * choice in it. Facts about those builds, not this build's defaults: they stay
 * as they are if the shipped defaults above ever change.
 */
export const CLIMB_ROW_LEGACY_KEY_DEFAULTS: Readonly<Record<ClimbRowLegacyFieldId, boolean>> = Object.freeze({
  playlistTags: false,
  quickActions: true,
});

/**
 * What this build last knew a field's old key to hold: the value last read from
 * it, or last confirmed written to it from here. `null` is a key with no
 * explicit choice in it. A field with no entry has never been read.
 *
 * Comparing an entry with a fresh read is how a write by an older build shows
 * up: the two differ.
 */
export type ClimbRowLegacyBaselines = Partial<Record<ClimbRowLegacyFieldId, boolean | null>>;

/**
 * A value chosen here that its old key is not yet known to hold. Recorded in the
 * same write as the choice, BEFORE the write to the old key is attempted, so a
 * write that fails, or lands after the app has died, is still known about at the
 * next launch. While a field has an entry, nothing read from its old key
 * replaces the choice: at worst that is one of our own overtaken writes.
 */
export type ClimbRowLegacyPending = Partial<Record<ClimbRowLegacyFieldId, boolean>>;

/** The two old keys as read: anything but an explicit boolean counts as no choice. */
export type ClimbRowLegacyValues = Record<ClimbRowLegacyFieldId, unknown>;

export type StoredClimbRowDisplay = {
  version: 1;
  overrides: ClimbRowOverrides;
  /**
   * The hand-made mix a preset replaced, kept so trying a preset can be undone.
   * Present only while a preset is showing: a mix that is on screen again, or
   * that a newer hand-made one replaced, has nothing left to go back to.
   */
  lastCustom?: Record<ClimbRowPresetFieldId, boolean>;
  /** Per old key, what it was last known to hold. Left out until one is known. */
  legacy?: ClimbRowLegacyBaselines;
  /** Per old key, a value chosen here and not yet confirmed written to it. */
  legacyPending?: ClimbRowLegacyPending;
};

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

export function resolveClimbRowDisplay(overrides: ClimbRowOverrides): ClimbRowDisplay {
  const display = { ...DEFAULT_CLIMB_ROW_DISPLAY };
  for (const fieldId of CLIMB_ROW_FIELD_IDS) {
    const override = overrides[fieldId];
    if (typeof override === 'boolean') display[fieldId] = override;
  }
  return Object.freeze(display);
}

/** The row minus `quickActions`: the part a preset, or a remembered mix, describes. */
function contentFieldsOf(display: ClimbRowDisplay): Record<ClimbRowPresetFieldId, boolean> {
  const contentFields: Record<ClimbRowPresetFieldId, boolean> = { ...CLIMB_ROW_PRESETS.default };
  for (const fieldId of CLIMB_ROW_PRESET_FIELD_IDS) contentFields[fieldId] = display[fieldId];
  return contentFields;
}

/** Rebuilds the record field by field, so an absent or empty optional key stays absent. */
function buildStored(parts: {
  overrides: ClimbRowOverrides;
  lastCustom: StoredClimbRowDisplay['lastCustom'];
  legacy: StoredClimbRowDisplay['legacy'];
  legacyPending: StoredClimbRowDisplay['legacyPending'];
}): StoredClimbRowDisplay {
  const { lastCustom, legacy, legacyPending } = parts;
  const stored: StoredClimbRowDisplay = { version: 1, overrides: parts.overrides };
  if (lastCustom) stored.lastCustom = lastCustom;
  if (legacy && CLIMB_ROW_LEGACY_FIELD_IDS.some((fieldId) => legacy[fieldId] !== undefined)) stored.legacy = legacy;
  if (legacyPending && CLIMB_ROW_LEGACY_FIELD_IDS.some((fieldId) => legacyPending[fieldId] !== undefined)) {
    stored.legacyPending = legacyPending;
  }
  return stored;
}

/** The old keys a preset, or a restored mix, speaks for: every one but `quickActions`. */
const PRESET_LEGACY_FIELD_IDS = CLIMB_ROW_PRESET_FIELD_IDS.filter(
  (fieldId): fieldId is ClimbRowPresetFieldId & ClimbRowLegacyFieldId => isClimbRowLegacyFieldId(fieldId),
);

/**
 * The pending values after the climber chose these fields here: what each now
 * shows is owed to its old key, replacing anything owed before.
 */
function pendingAfterDeciding(
  pending: StoredClimbRowDisplay['legacyPending'],
  decidedFieldIds: readonly ClimbRowLegacyFieldId[],
  display: ClimbRowDisplay,
): ClimbRowLegacyPending {
  const owed: ClimbRowLegacyPending = { ...pending };
  for (const fieldId of decidedFieldIds) owed[fieldId] = display[fieldId];
  return owed;
}

/** The overrides a preset or a restored mix must leave alone. */
function overridesOutsidePresets(overrides: ClimbRowOverrides): ClimbRowOverrides {
  return typeof overrides.quickActions === 'boolean' ? { quickActions: overrides.quickActions } : {};
}

function sanitiseOverrides(candidate: unknown): ClimbRowOverrides {
  const overrides: ClimbRowOverrides = {};
  if (!isRecord(candidate)) return overrides;
  for (const fieldId of CLIMB_ROW_FIELD_IDS) {
    const storedValue = candidate[fieldId];
    if (typeof storedValue === 'boolean') overrides[fieldId] = storedValue;
  }
  return overrides;
}

/**
 * A remembered mix is kept when it still says something: at least one real
 * boolean, and not a row a preset already describes. A field it lacks (one added
 * after it was saved) takes the shipped default.
 */
function sanitiseLastCustom(candidate: unknown): StoredClimbRowDisplay['lastCustom'] {
  if (!isRecord(candidate)) return undefined;
  if (!CLIMB_ROW_PRESET_FIELD_IDS.some((fieldId) => typeof candidate[fieldId] === 'boolean')) return undefined;
  const remembered = resolveClimbRowDisplay(sanitiseOverrides(candidate));
  return matchClimbRowPreset(remembered) === 'custom' ? contentFieldsOf(remembered) : undefined;
}

function sanitiseLegacy(candidate: unknown): StoredClimbRowDisplay['legacy'] {
  if (!isRecord(candidate)) return undefined;
  const legacy: ClimbRowLegacyBaselines = {};
  for (const fieldId of CLIMB_ROW_LEGACY_FIELD_IDS) {
    const baseline = candidate[fieldId];
    if (typeof baseline === 'boolean' || baseline === null) legacy[fieldId] = baseline;
  }
  return legacy;
}

function sanitiseLegacyPending(candidate: unknown): StoredClimbRowDisplay['legacyPending'] {
  if (!isRecord(candidate)) return undefined;
  const pending: ClimbRowLegacyPending = {};
  for (const fieldId of CLIMB_ROW_LEGACY_FIELD_IDS) {
    const owed = candidate[fieldId];
    if (typeof owed === 'boolean') pending[fieldId] = owed;
  }
  return pending;
}

/**
 * Whatever was read from storage, as a record this build understands. A wrong
 * version, a non-object, an unknown field id and a value of the wrong type are
 * all dropped; nothing here throws, because a row that cannot read its settings
 * must still draw.
 */
export function sanitiseStoredClimbRowDisplay(stored: unknown): StoredClimbRowDisplay {
  if (!isRecord(stored) || stored.version !== 1) return { version: 1, overrides: {} };
  const overrides = sanitiseOverrides(stored.overrides);
  // A remembered mix only means something while a preset is showing.
  const showsPreset = matchClimbRowPreset(resolveClimbRowDisplay(overrides)) !== 'custom';
  return buildStored({
    overrides,
    lastCustom: showsPreset ? sanitiseLastCustom(stored.lastCustom) : undefined,
    legacy: sanitiseLegacy(stored.legacy),
    legacyPending: sanitiseLegacyPending(stored.legacyPending),
  });
}

export function sameStoredClimbRowDisplay(first: StoredClimbRowDisplay, second: StoredClimbRowDisplay): boolean {
  for (const fieldId of CLIMB_ROW_LEGACY_FIELD_IDS) {
    // `undefined` (never read) and `null` (read, nothing there) are different baselines.
    if (first.legacy?.[fieldId] !== second.legacy?.[fieldId]) return false;
    if (first.legacyPending?.[fieldId] !== second.legacyPending?.[fieldId]) return false;
  }
  if (!CLIMB_ROW_FIELD_IDS.every((fieldId) => first.overrides[fieldId] === second.overrides[fieldId])) return false;
  const firstCustom = first.lastCustom;
  const secondCustom = second.lastCustom;
  if (!firstCustom || !secondCustom) return firstCustom === secondCustom;
  return CLIMB_ROW_PRESET_FIELD_IDS.every((fieldId) => firstCustom[fieldId] === secondCustom[fieldId]);
}

/** One switch flipped by hand. */
export function withClimbRowField(
  stored: StoredClimbRowDisplay,
  fieldId: ClimbRowFieldId,
  value: boolean,
): StoredClimbRowDisplay {
  const overrides = { ...stored.overrides, [fieldId]: value };
  const display = resolveClimbRowDisplay(overrides);
  // A flip that leaves the presets makes this row the newest hand-made mix, so
  // the older remembered one has nothing left to restore.
  const showsPreset = matchClimbRowPreset(display) !== 'custom';
  return buildStored({
    overrides,
    lastCustom: showsPreset ? stored.lastCustom : undefined,
    legacy: stored.legacy,
    legacyPending: isClimbRowLegacyFieldId(fieldId)
      ? pendingAfterDeciding(stored.legacyPending, [fieldId], display)
      : stored.legacyPending,
  });
}

/**
 * A preset applied. A hand-made mix on screen is remembered first, so the
 * preset can be undone.
 *
 * `default` CLEARS the content overrides instead of writing its values: a
 * climber on Default then follows the shipped defaults, including any we change
 * later. Every other preset is a deliberate row, so it writes all of its values.
 */
export function withClimbRowPreset(stored: StoredClimbRowDisplay, presetId: ClimbRowPresetId): StoredClimbRowDisplay {
  const currentDisplay = resolveClimbRowDisplay(stored.overrides);
  const lastCustom =
    matchClimbRowPreset(currentDisplay) === 'custom' ? contentFieldsOf(currentDisplay) : stored.lastCustom;
  const overrides = overridesOutsidePresets(stored.overrides);
  if (presetId !== 'default') Object.assign(overrides, CLIMB_ROW_PRESETS[presetId]);
  return buildStored({
    overrides,
    lastCustom,
    legacy: stored.legacy,
    legacyPending: pendingAfterDeciding(
      stored.legacyPending,
      PRESET_LEGACY_FIELD_IDS,
      resolveClimbRowDisplay(overrides),
    ),
  });
}

/** The remembered hand-made mix, back on screen. No remembered mix: no change. */
export function withClimbRowLastCustomRestored(stored: StoredClimbRowDisplay): StoredClimbRowDisplay {
  if (!stored.lastCustom) return stored;
  const overrides = { ...overridesOutsidePresets(stored.overrides), ...stored.lastCustom };
  return buildStored({
    overrides,
    lastCustom: undefined,
    legacy: stored.legacy,
    legacyPending: pendingAfterDeciding(
      stored.legacyPending,
      PRESET_LEGACY_FIELD_IDS,
      resolveClimbRowDisplay(overrides),
    ),
  });
}

/**
 * The two old keys, read at launch and reconciled with this record. Per field,
 * in this order:
 *
 * 1. A value is pending for the key: nothing read replaces the choice. A read
 *    equal to it means the write landed, so the entry is cleared.
 * 2. Otherwise the read is compared with the baseline. Equal, nothing happened
 *    since we last looked. Different, or never read, an older build's choice is
 *    waiting in the key and comes in, when it is an explicit boolean.
 * 3. The baseline becomes what was read.
 * 4. Heal: if a build that only knows the old key would now show something else
 *    than this record does, the value shown here becomes pending, so the caller
 *    writes it. This is what retries a write that failed or was cut off, and it
 *    asks nothing for a climber who never chose: both sides show the default.
 *
 * Whatever is pending afterwards still has to be written by the caller.
 */
export function withClimbRowLegacyRead(
  stored: StoredClimbRowDisplay,
  legacyValues: ClimbRowLegacyValues,
): StoredClimbRowDisplay {
  const overrides = { ...stored.overrides };
  const legacy: ClimbRowLegacyBaselines = { ...stored.legacy };
  const legacyPending: ClimbRowLegacyPending = {};
  for (const fieldId of CLIMB_ROW_LEGACY_FIELD_IDS) {
    const legacyValue = legacyValues[fieldId];
    const read = typeof legacyValue === 'boolean' ? legacyValue : null;
    const owed = stored.legacyPending?.[fieldId];
    if (owed !== undefined) {
      if (read !== owed) legacyPending[fieldId] = owed;
    } else if (read !== null && legacy[fieldId] !== read) {
      overrides[fieldId] = read;
    }
    legacy[fieldId] = read;
  }
  const display = resolveClimbRowDisplay(overrides);
  for (const fieldId of CLIMB_ROW_LEGACY_FIELD_IDS) {
    const shownByOlderBuild = legacy[fieldId] ?? CLIMB_ROW_LEGACY_KEY_DEFAULTS[fieldId];
    if (shownByOlderBuild !== display[fieldId]) legacyPending[fieldId] = display[fieldId];
  }
  const showsPreset = matchClimbRowPreset(display) !== 'custom';
  return buildStored({ overrides, lastCustom: showsPreset ? stored.lastCustom : undefined, legacy, legacyPending });
}

/**
 * A write of `value` to a field's old key has landed. It confirms the pending
 * value only when that is still the one written: then the key is known to hold
 * it and nothing is owed. A newer choice has replaced it otherwise, and its own
 * write is still to come, so the record is left exactly as it is.
 */
export function withClimbRowLegacyMirrored(
  stored: StoredClimbRowDisplay,
  fieldId: ClimbRowLegacyFieldId,
  value: boolean,
): StoredClimbRowDisplay {
  if (stored.legacyPending?.[fieldId] !== value) return stored;
  const legacyPending: ClimbRowLegacyPending = {};
  for (const otherFieldId of CLIMB_ROW_LEGACY_FIELD_IDS) {
    const owed = stored.legacyPending[otherFieldId];
    if (otherFieldId !== fieldId && owed !== undefined) legacyPending[otherFieldId] = owed;
  }
  return buildStored({
    overrides: stored.overrides,
    lastCustom: stored.lastCustom,
    legacy: { ...stored.legacy, [fieldId]: value },
    legacyPending,
  });
}

/**
 * The record after every setting was reset from outside. A reset is a choice
 * like any other: back to the shipped defaults, and each old key is owed its
 * default, so a read still in flight cannot bring the old choices back and a
 * build that only knows the old keys shows the reset too. Both keys, whatever
 * the baselines say: at this point they can be stale, or not there yet.
 */
export function withClimbRowDisplayReset(stored: StoredClimbRowDisplay): StoredClimbRowDisplay {
  return buildStored({
    overrides: {},
    lastCustom: undefined,
    legacy: stored.legacy,
    legacyPending: pendingAfterDeciding(undefined, CLIMB_ROW_LEGACY_FIELD_IDS, DEFAULT_CLIMB_ROW_DISPLAY),
  });
}
