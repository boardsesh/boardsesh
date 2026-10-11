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
    playlistTags: false,
  },
  textOnly: {
    thumbnail: false,
    communityGrade: true,
    sends: true,
    rating: true,
    setter: true,
    sentMark: true,
    playlistTags: false,
  },
  default: {
    thumbnail: true,
    communityGrade: true,
    sends: true,
    rating: true,
    setter: true,
    sentMark: true,
    playlistTags: false,
  },
  everything: {
    thumbnail: true,
    communityGrade: true,
    sends: true,
    rating: true,
    setter: true,
    sentMark: true,
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

export type StoredClimbRowDisplay = {
  version: 1;
  overrides: ClimbRowOverrides;
  /**
   * The hand-made mix a preset replaced, kept so trying a preset can be undone.
   * Present only while a preset is showing: a mix that is on screen again, or
   * that a newer hand-made one replaced, has nothing left to go back to.
   */
  lastCustom?: Record<ClimbRowPresetFieldId, boolean>;
  /** The two older AsyncStorage choices have been copied in (or were absent). */
  legacyMigrated?: true;
};

/** The two choices that had their own AsyncStorage key before this record. */
export type LegacyClimbRowChoices = { playlistTags: unknown; quickActions: unknown };

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

/** Rebuilds the record field by field, so an absent optional key stays absent. */
function buildStored(
  overrides: ClimbRowOverrides,
  lastCustom: StoredClimbRowDisplay['lastCustom'],
  legacyMigrated: StoredClimbRowDisplay['legacyMigrated'],
): StoredClimbRowDisplay {
  const stored: StoredClimbRowDisplay = { version: 1, overrides };
  if (lastCustom) stored.lastCustom = lastCustom;
  if (legacyMigrated) stored.legacyMigrated = true;
  return stored;
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

/**
 * Whatever was read from storage, as a record this build understands. A wrong
 * version, a non-object, an unknown field id and a non-boolean value are all
 * dropped; nothing here throws, because a row that cannot read its settings
 * must still draw.
 */
export function sanitiseStoredClimbRowDisplay(stored: unknown): StoredClimbRowDisplay {
  if (!isRecord(stored) || stored.version !== 1) return { version: 1, overrides: {} };
  const overrides = sanitiseOverrides(stored.overrides);
  // A remembered mix only means something while a preset is showing.
  const showsPreset = matchClimbRowPreset(resolveClimbRowDisplay(overrides)) !== 'custom';
  return buildStored(
    overrides,
    showsPreset ? sanitiseLastCustom(stored.lastCustom) : undefined,
    stored.legacyMigrated === true ? true : undefined,
  );
}

export function sameStoredClimbRowDisplay(first: StoredClimbRowDisplay, second: StoredClimbRowDisplay): boolean {
  if (first.legacyMigrated !== second.legacyMigrated) return false;
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
  // A flip that leaves the presets makes this row the newest hand-made mix, so
  // the older remembered one has nothing left to restore.
  const showsPreset = matchClimbRowPreset(resolveClimbRowDisplay(overrides)) !== 'custom';
  return buildStored(overrides, showsPreset ? stored.lastCustom : undefined, stored.legacyMigrated);
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
  return buildStored(overrides, lastCustom, stored.legacyMigrated);
}

/** The remembered hand-made mix, back on screen. No remembered mix: no change. */
export function withClimbRowLastCustomRestored(stored: StoredClimbRowDisplay): StoredClimbRowDisplay {
  if (!stored.lastCustom) return stored;
  return buildStored(
    { ...overridesOutsidePresets(stored.overrides), ...stored.lastCustom },
    undefined,
    stored.legacyMigrated,
  );
}

/**
 * The two older choices, copied in once. Only an explicit stored boolean counts:
 * a key that was never written keeps following the default. A field the climber
 * has already decided here (an override on file, or a change made this launch,
 * which `default` records by clearing) wins over the older value.
 */
export function withClimbRowLegacyChoices(
  stored: StoredClimbRowDisplay,
  legacyChoices: LegacyClimbRowChoices,
  changedFieldIds: ReadonlySet<ClimbRowFieldId>,
): StoredClimbRowDisplay {
  const overrides = { ...stored.overrides };
  for (const fieldId of ['playlistTags', 'quickActions'] as const) {
    const legacyChoice = legacyChoices[fieldId];
    if (typeof legacyChoice !== 'boolean') continue;
    if (changedFieldIds.has(fieldId) || typeof overrides[fieldId] === 'boolean') continue;
    overrides[fieldId] = legacyChoice;
  }
  const showsPreset = matchClimbRowPreset(resolveClimbRowDisplay(overrides)) !== 'custom';
  return buildStored(overrides, showsPreset ? stored.lastCustom : undefined, true);
}
