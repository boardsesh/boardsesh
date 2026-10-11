import { describe, expect, it } from 'vitest';
import {
  CLIMB_ROW_FIELD_IDS,
  CLIMB_ROW_PRESET_FIELD_IDS,
  CLIMB_ROW_PRESET_IDS,
  CLIMB_ROW_PRESETS,
  DEFAULT_CLIMB_ROW_DISPLAY,
  matchClimbRowPreset,
  resolveClimbRowDisplay,
  sameStoredClimbRowDisplay,
  sanitiseStoredClimbRowDisplay,
  withClimbRowField,
  withClimbRowLastCustomRestored,
  withClimbRowLegacyChoices,
  withClimbRowPreset,
  type ClimbRowDisplay,
  type ClimbRowFieldId,
  type ClimbRowPresetFieldId,
  type StoredClimbRowDisplay,
} from '../climb-row-display';

const EMPTY: StoredClimbRowDisplay = { version: 1, overrides: {} };
const NOTHING_CHANGED: ReadonlySet<ClimbRowFieldId> = new Set();

function contentOf(display: ClimbRowDisplay): Record<string, boolean> {
  return Object.fromEntries(CLIMB_ROW_PRESET_FIELD_IDS.map((fieldId) => [fieldId, display[fieldId]]));
}

function displayOf(stored: StoredClimbRowDisplay): ClimbRowDisplay {
  return resolveClimbRowDisplay(stored.overrides);
}

describe('the default row', () => {
  it('is today’s row: everything on but the playlist tags', () => {
    expect(DEFAULT_CLIMB_ROW_DISPLAY).toEqual({
      thumbnail: true,
      communityGrade: true,
      sends: true,
      rating: true,
      setter: true,
      sentMark: true,
      playlistTags: false,
      quickActions: true,
    });
  });

  it('names every field and cannot be changed in place', () => {
    expect(Object.keys(DEFAULT_CLIMB_ROW_DISPLAY).sort()).toEqual([...CLIMB_ROW_FIELD_IDS].sort());
    expect(Object.isFrozen(DEFAULT_CLIMB_ROW_DISPLAY)).toBe(true);
  });
});

describe('resolveClimbRowDisplay', () => {
  it('is the default when nothing is overridden', () => {
    expect(resolveClimbRowDisplay({})).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });

  it('lays the overrides over the default and leaves the rest alone', () => {
    expect(resolveClimbRowDisplay({ thumbnail: false, playlistTags: true })).toEqual({
      ...DEFAULT_CLIMB_ROW_DISPLAY,
      thumbnail: false,
      playlistTags: true,
    });
  });

  it('returns a frozen row', () => {
    expect(Object.isFrozen(resolveClimbRowDisplay({ sends: false }))).toBe(true);
  });

  it('ignores an override that is not a boolean', () => {
    const overrides = { sends: undefined, rating: 'no' } as unknown as Parameters<typeof resolveClimbRowDisplay>[0];
    expect(resolveClimbRowDisplay(overrides)).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });
});

describe('presets', () => {
  it('cover every field except the quick-actions button', () => {
    expect(CLIMB_ROW_PRESET_FIELD_IDS).toEqual(CLIMB_ROW_FIELD_IDS.filter((fieldId) => fieldId !== 'quickActions'));
  });

  it.each(CLIMB_ROW_PRESET_IDS)('%s decides every content field, and only those', (presetId) => {
    const preset: Record<string, unknown> = CLIMB_ROW_PRESETS[presetId];
    expect(Object.keys(preset).sort()).toEqual([...CLIMB_ROW_PRESET_FIELD_IDS].sort());
    for (const fieldId of CLIMB_ROW_PRESET_FIELD_IDS) expect(typeof preset[fieldId]).toBe('boolean');
  });

  it('default is the default row', () => {
    expect(CLIMB_ROW_PRESETS.default).toEqual(contentOf(DEFAULT_CLIMB_ROW_DISPLAY));
  });

  it('have the values the Climb list screen promises', () => {
    const on = (presetId: (typeof CLIMB_ROW_PRESET_IDS)[number]) =>
      CLIMB_ROW_PRESET_FIELD_IDS.filter((fieldId) => CLIMB_ROW_PRESETS[presetId][fieldId]);
    expect(on('namesOnly')).toEqual(['sentMark']);
    expect(on('textOnly')).toEqual(['communityGrade', 'sends', 'rating', 'setter', 'sentMark']);
    expect(on('default')).toEqual(['thumbnail', 'communityGrade', 'sends', 'rating', 'setter', 'sentMark']);
    expect(on('everything')).toEqual([...CLIMB_ROW_PRESET_FIELD_IDS]);
  });

  it('are all different, so a row can only ever match one', () => {
    const serialised = CLIMB_ROW_PRESET_IDS.map((presetId) =>
      CLIMB_ROW_PRESET_FIELD_IDS.map((fieldId) => (CLIMB_ROW_PRESETS[presetId][fieldId] ? '1' : '0')).join(''),
    );
    expect(new Set(serialised).size).toBe(CLIMB_ROW_PRESET_IDS.length);
  });
});

describe('matchClimbRowPreset', () => {
  it.each(CLIMB_ROW_PRESET_IDS)('recognises %s once it is applied', (presetId) => {
    expect(matchClimbRowPreset(displayOf(withClimbRowPreset(EMPTY, presetId)))).toBe(presetId);
  });

  it('reads the untouched row as default', () => {
    expect(matchClimbRowPreset(DEFAULT_CLIMB_ROW_DISPLAY)).toBe('default');
  });

  it.each(CLIMB_ROW_PRESET_IDS.flatMap((presetId) => CLIMB_ROW_PRESET_FIELD_IDS.map((fieldId) => [presetId, fieldId])))(
    'reads %s with %s flipped as another preset or custom, never as itself',
    (presetId, fieldId) => {
      const applied = displayOf(withClimbRowPreset(EMPTY, presetId as (typeof CLIMB_ROW_PRESET_IDS)[number]));
      const flipped = { ...applied, [fieldId]: !applied[fieldId as ClimbRowPresetFieldId] };
      expect(matchClimbRowPreset(flipped)).not.toBe(presetId);
    },
  );

  it('reads a mix no preset describes as custom', () => {
    expect(matchClimbRowPreset({ ...DEFAULT_CLIMB_ROW_DISPLAY, setter: false })).toBe('custom');
  });

  it.each(CLIMB_ROW_PRESET_IDS)('does not look at the quick-actions button (%s)', (presetId) => {
    const applied = displayOf(withClimbRowPreset(EMPTY, presetId));
    expect(matchClimbRowPreset({ ...applied, quickActions: true })).toBe(presetId);
    expect(matchClimbRowPreset({ ...applied, quickActions: false })).toBe(presetId);
  });
});

describe('sanitiseStoredClimbRowDisplay', () => {
  it.each([
    ['nothing stored', null],
    ['undefined', undefined],
    ['a string', 'everything'],
    ['a number', 1],
    ['a boolean', true],
    ['an array', [{ version: 1 }]],
    ['an object with no version', { overrides: { sends: false } }],
    ['a newer version', { version: 2, overrides: { sends: false } }],
    ['a version of the wrong type', { version: '1', overrides: { sends: false } }],
  ])('starts from an empty record for %s', (_label, stored) => {
    expect(sanitiseStoredClimbRowDisplay(stored)).toEqual(EMPTY);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'sends'],
    ['an array', [true]],
  ])('reads overrides that are %s as none', (_label, overrides) => {
    expect(sanitiseStoredClimbRowDisplay({ version: 1, overrides })).toEqual(EMPTY);
  });

  it('keeps boolean overrides for known fields and drops everything else', () => {
    const stored = sanitiseStoredClimbRowDisplay({
      version: 1,
      overrides: { thumbnail: false, quickActions: false, sends: 'false', rating: 0, setter: null, glitter: true },
      somethingElse: 'ignored',
    });
    expect(stored).toEqual({ version: 1, overrides: { thumbnail: false, quickActions: false } });
  });

  it('keeps the legacy marker only when it is exactly true', () => {
    expect(sanitiseStoredClimbRowDisplay({ version: 1, overrides: {}, legacyMigrated: true }).legacyMigrated).toBe(
      true,
    );
    for (const marker of [false, 'true', 1, null]) {
      expect(sanitiseStoredClimbRowDisplay({ version: 1, overrides: {}, legacyMigrated: marker })).toEqual(EMPTY);
    }
  });

  it('keeps a remembered mix while a preset is showing, filling a field it lacks from the default', () => {
    const stored = sanitiseStoredClimbRowDisplay({
      version: 1,
      overrides: CLIMB_ROW_PRESETS.textOnly,
      lastCustom: { thumbnail: true, setter: false, sends: 'yes', glitter: true },
    });
    expect(stored.lastCustom).toEqual({ ...CLIMB_ROW_PRESETS.default, setter: false });
  });

  it.each([
    ['is not an object', 'mine'],
    ['is null', null],
    ['has no boolean field', { thumbnail: 'no', glitter: true }],
    ['describes a preset, not a mix', CLIMB_ROW_PRESETS.namesOnly],
  ])('drops a remembered mix that %s', (_label, lastCustom) => {
    const stored = sanitiseStoredClimbRowDisplay({ version: 1, overrides: {}, lastCustom });
    expect(stored).toEqual(EMPTY);
  });

  it('drops a remembered mix when the row on screen is itself a hand-made mix', () => {
    const stored = sanitiseStoredClimbRowDisplay({
      version: 1,
      overrides: { rating: false },
      lastCustom: { ...CLIMB_ROW_PRESETS.default, setter: false },
    });
    expect(stored).toEqual({ version: 1, overrides: { rating: false } });
  });

  it('gives back an equal record for one it produced', () => {
    const produced = withClimbRowPreset(withClimbRowField(EMPTY, 'setter', false), 'everything');
    const reread = sanitiseStoredClimbRowDisplay(JSON.parse(JSON.stringify(produced)));
    expect(reread).toEqual(produced);
    expect(sameStoredClimbRowDisplay(reread, produced)).toBe(true);
  });
});

describe('sameStoredClimbRowDisplay', () => {
  const remembered = { ...CLIMB_ROW_PRESETS.default, setter: false };

  it('ignores key order and treats two empty records as equal', () => {
    expect(sameStoredClimbRowDisplay(EMPTY, { version: 1, overrides: {} })).toBe(true);
    expect(
      sameStoredClimbRowDisplay(
        { version: 1, overrides: { sends: false, thumbnail: false } },
        { version: 1, overrides: { thumbnail: false, sends: false } },
      ),
    ).toBe(true);
  });

  it.each<[string, StoredClimbRowDisplay, StoredClimbRowDisplay]>([
    ['an override', EMPTY, { version: 1, overrides: { sends: true } }],
    ['an override’s value', { version: 1, overrides: { sends: true } }, { version: 1, overrides: { sends: false } }],
    ['the legacy marker', EMPTY, { version: 1, overrides: {}, legacyMigrated: true }],
    ['a remembered mix', EMPTY, { version: 1, overrides: {}, lastCustom: remembered }],
    [
      'the remembered mix’s values',
      { version: 1, overrides: {}, lastCustom: remembered },
      { version: 1, overrides: {}, lastCustom: { ...remembered, rating: false } },
    ],
  ])('tells two records apart by %s', (_label, first, second) => {
    expect(sameStoredClimbRowDisplay(first, second)).toBe(false);
    expect(sameStoredClimbRowDisplay(second, first)).toBe(false);
  });
});

describe('withClimbRowField', () => {
  it('records the choice as an override, even when it equals the default', () => {
    expect(withClimbRowField(EMPTY, 'sends', true).overrides).toEqual({ sends: true });
    expect(withClimbRowField(EMPTY, 'sends', false).overrides).toEqual({ sends: false });
  });

  it('does not change the record it was given', () => {
    const before: StoredClimbRowDisplay = { version: 1, overrides: { sends: false } };
    withClimbRowField(before, 'rating', false);
    expect(before).toEqual({ version: 1, overrides: { sends: false } });
  });

  it('keeps the legacy marker', () => {
    expect(withClimbRowField({ ...EMPTY, legacyMigrated: true }, 'sends', false).legacyMigrated).toBe(true);
  });
});

describe('withClimbRowPreset', () => {
  it('writes every content value of a preset', () => {
    expect(withClimbRowPreset(EMPTY, 'namesOnly').overrides).toEqual(CLIMB_ROW_PRESETS.namesOnly);
    expect(withClimbRowPreset(EMPTY, 'everything').overrides).toEqual(CLIMB_ROW_PRESETS.everything);
  });

  it('clears the content overrides for default, so a later change to the shipped defaults still arrives', () => {
    const everything = withClimbRowPreset(EMPTY, 'everything');
    expect(withClimbRowPreset(everything, 'default').overrides).toEqual({});
  });

  it.each(CLIMB_ROW_PRESET_IDS)('leaves a quick-actions choice alone (%s)', (presetId) => {
    const hidden = withClimbRowField(EMPTY, 'quickActions', false);
    const applied = withClimbRowPreset(hidden, presetId);
    expect(applied.overrides.quickActions).toBe(false);
    expect(displayOf(applied).quickActions).toBe(false);
  });

  it.each(CLIMB_ROW_PRESET_IDS)('adds no quick-actions override of its own (%s)', (presetId) => {
    expect('quickActions' in withClimbRowPreset(EMPTY, presetId).overrides).toBe(false);
  });
});

describe('the remembered hand-made mix', () => {
  const handMade = withClimbRowField(withClimbRowField(EMPTY, 'setter', false), 'playlistTags', true);
  const handMadeContent = { ...CLIMB_ROW_PRESETS.default, setter: false, playlistTags: true };

  it('is captured when a preset replaces a mix no preset describes', () => {
    expect(matchClimbRowPreset(displayOf(handMade))).toBe('custom');
    expect(withClimbRowPreset(handMade, 'textOnly').lastCustom).toEqual(handMadeContent);
  });

  it('is not captured when one preset replaces another', () => {
    expect(withClimbRowPreset(withClimbRowPreset(EMPTY, 'textOnly'), 'everything').lastCustom).toBeUndefined();
  });

  it('survives moving between presets', () => {
    const viaTwoPresets = withClimbRowPreset(withClimbRowPreset(handMade, 'textOnly'), 'default');
    expect(viaTwoPresets.lastCustom).toEqual(handMadeContent);
  });

  it('comes back exactly, and is then used up', () => {
    const restored = withClimbRowLastCustomRestored(withClimbRowPreset(handMade, 'namesOnly'));
    expect(contentOf(displayOf(restored))).toEqual(handMadeContent);
    expect(matchClimbRowPreset(displayOf(restored))).toBe('custom');
    expect(restored.lastCustom).toBeUndefined();
  });

  it('can be tried and undone again and again', () => {
    const roundTrip = withClimbRowLastCustomRestored(
      withClimbRowPreset(withClimbRowLastCustomRestored(withClimbRowPreset(handMade, 'namesOnly')), 'everything'),
    );
    expect(contentOf(displayOf(roundTrip))).toEqual(handMadeContent);
  });

  it('restores around a quick-actions choice without touching it', () => {
    const hidden = withClimbRowField(handMade, 'quickActions', false);
    const restored = withClimbRowLastCustomRestored(withClimbRowPreset(hidden, 'everything'));
    expect(displayOf(restored).quickActions).toBe(false);
    expect(contentOf(displayOf(restored))).toEqual(handMadeContent);
  });

  it('is replaced once the climber hand-edits a preset into a new mix', () => {
    const edited = withClimbRowField(withClimbRowPreset(handMade, 'textOnly'), 'rating', false);
    expect(matchClimbRowPreset(displayOf(edited))).toBe('custom');
    expect(edited.lastCustom).toBeUndefined();
    // The new mix is the one a later preset remembers.
    expect(withClimbRowPreset(edited, 'default').lastCustom).toEqual({ ...CLIMB_ROW_PRESETS.textOnly, rating: false });
  });

  it('is kept when a hand edit lands on another preset, or only moves the quick-actions button', () => {
    const onTextOnly = withClimbRowPreset(handMade, 'textOnly');
    expect(withClimbRowField(onTextOnly, 'thumbnail', true).lastCustom).toEqual(handMadeContent);
    expect(withClimbRowField(onTextOnly, 'quickActions', false).lastCustom).toEqual(handMadeContent);
  });

  it('restoring with nothing remembered changes nothing', () => {
    const onPreset = withClimbRowPreset(EMPTY, 'everything');
    expect(withClimbRowLastCustomRestored(onPreset)).toBe(onPreset);
  });
});

describe('withClimbRowLegacyChoices', () => {
  it('copies explicit choices and marks the copy done', () => {
    const migrated = withClimbRowLegacyChoices(EMPTY, { playlistTags: true, quickActions: false }, NOTHING_CHANGED);
    expect(migrated).toEqual({
      version: 1,
      overrides: { playlistTags: true, quickActions: false },
      legacyMigrated: true,
    });
  });

  it('copies an explicit choice that equals the default too', () => {
    const migrated = withClimbRowLegacyChoices(EMPTY, { playlistTags: false, quickActions: true }, NOTHING_CHANGED);
    expect(migrated.overrides).toEqual({ playlistTags: false, quickActions: true });
  });

  it.each([
    ['never written', null],
    ['undefined', undefined],
    ['a string', 'true'],
    ['a number', 1],
    ['an object', { enabled: true }],
  ])('ignores a legacy value that is %s, and still marks the copy done', (_label, legacyValue) => {
    const migrated = withClimbRowLegacyChoices(
      EMPTY,
      { playlistTags: legacyValue, quickActions: legacyValue },
      NOTHING_CHANGED,
    );
    expect(migrated).toEqual({ version: 1, overrides: {}, legacyMigrated: true });
  });

  it('lets a field changed this launch win, and still copies the other', () => {
    const changed = withClimbRowField(EMPTY, 'playlistTags', false);
    const migrated = withClimbRowLegacyChoices(
      changed,
      { playlistTags: true, quickActions: false },
      new Set<ClimbRowFieldId>(['playlistTags']),
    );
    expect(migrated.overrides).toEqual({ playlistTags: false, quickActions: false });
  });

  it('lets a field cleared by the default preset this launch win', () => {
    const onDefault = withClimbRowPreset(EMPTY, 'default');
    const migrated = withClimbRowLegacyChoices(
      onDefault,
      { playlistTags: true, quickActions: null },
      new Set<ClimbRowFieldId>(CLIMB_ROW_PRESET_FIELD_IDS),
    );
    expect(displayOf(migrated).playlistTags).toBe(false);
  });

  it('lets an override already on file win, whenever it was made', () => {
    const migrated = withClimbRowLegacyChoices(
      { version: 1, overrides: { quickActions: true } },
      { playlistTags: null, quickActions: false },
      NOTHING_CHANGED,
    );
    expect(migrated.overrides).toEqual({ quickActions: true });
  });

  it('keeps a remembered mix when the copied tags leave the row on a preset', () => {
    // Default from an earlier launch whose copy failed: nothing overrides the tags,
    // so the older choice lands, and Default plus tags is the Everything preset.
    const onDefault = withClimbRowPreset(withClimbRowField(EMPTY, 'setter', false), 'default');
    const migrated = withClimbRowLegacyChoices(onDefault, { playlistTags: true, quickActions: null }, NOTHING_CHANGED);
    expect(matchClimbRowPreset(displayOf(migrated))).toBe('everything');
    expect(migrated.lastCustom).toEqual({ ...CLIMB_ROW_PRESETS.default, setter: false });
  });
});
