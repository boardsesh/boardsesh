import { describe, expect, it } from 'vitest';
import {
  CLIMB_ROW_FIELD_IDS,
  CLIMB_ROW_LEGACY_FIELD_IDS,
  CLIMB_ROW_PRESET_FIELD_IDS,
  CLIMB_ROW_PRESET_IDS,
  CLIMB_ROW_PRESETS,
  DEFAULT_CLIMB_ROW_DISPLAY,
  isClimbRowLegacyFieldId,
  matchClimbRowPreset,
  resolveClimbRowDisplay,
  sameStoredClimbRowDisplay,
  sanitiseStoredClimbRowDisplay,
  withClimbRowDisplayReset,
  withClimbRowField,
  withClimbRowLastCustomRestored,
  withClimbRowLegacyMirrored,
  withClimbRowLegacyRead,
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

  it('keeps a baseline for each old key: a boolean, null, or decided', () => {
    for (const baseline of [true, false, null, 'decided'] as const) {
      const legacy = { playlistTags: baseline, quickActions: baseline };
      expect(sanitiseStoredClimbRowDisplay({ version: 1, overrides: {}, legacy })).toEqual({ ...EMPTY, legacy });
    }
  });

  it('tells a key that was read and held nothing from one that was never read', () => {
    const stored = sanitiseStoredClimbRowDisplay({ version: 1, overrides: {}, legacy: { playlistTags: null } });
    expect(stored.legacy).toEqual({ playlistTags: null });
    expect(stored.legacy && 'quickActions' in stored.legacy).toBe(false);
  });

  it('drops a baseline of any other kind, and one for a field that never had an old key', () => {
    const stored = sanitiseStoredClimbRowDisplay({
      version: 1,
      overrides: {},
      legacy: { playlistTags: 'true', quickActions: 1, thumbnail: true, glitter: false },
    });
    expect(stored).toEqual(EMPTY);
    for (const legacy of ['decided', null, [true], 7]) {
      expect(sanitiseStoredClimbRowDisplay({ version: 1, overrides: {}, legacy })).toEqual(EMPTY);
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
    ['a baseline', EMPTY, { version: 1, overrides: {}, legacy: { quickActions: true } }],
    [
      'a baseline’s value',
      { version: 1, overrides: {}, legacy: { quickActions: true } },
      { version: 1, overrides: {}, legacy: { quickActions: 'decided' } },
    ],
    ['a key read as empty versus never read', EMPTY, { version: 1, overrides: {}, legacy: { playlistTags: null } }],
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

  it('leaves the baselines alone for a field that never had an old key', () => {
    expect(withClimbRowField(EMPTY, 'sends', false).legacy).toBeUndefined();
    const read: StoredClimbRowDisplay = { ...EMPTY, legacy: { playlistTags: true, quickActions: null } };
    expect(withClimbRowField(read, 'sends', false).legacy).toEqual({ playlistTags: true, quickActions: null });
  });

  it.each(CLIMB_ROW_LEGACY_FIELD_IDS)(
    'marks %s decided when its old key has never been read, in the same record as the choice',
    (fieldId) => {
      const decided = withClimbRowField(EMPTY, fieldId, false);
      expect(decided.overrides).toEqual({ [fieldId]: false });
      expect(decided.legacy).toEqual({ [fieldId]: 'decided' });
    },
  );

  it.each([true, false, null, 'decided'] as const)('keeps a baseline that is already %s', (baseline) => {
    const read: StoredClimbRowDisplay = { ...EMPTY, legacy: { quickActions: baseline } };
    expect(withClimbRowField(read, 'quickActions', false).legacy).toEqual({ quickActions: baseline });
  });
});

describe('the fields with an old key', () => {
  it('are the playlist tags and the quick-actions button', () => {
    expect(CLIMB_ROW_LEGACY_FIELD_IDS).toEqual(['playlistTags', 'quickActions']);
    expect(CLIMB_ROW_FIELD_IDS.filter(isClimbRowLegacyFieldId)).toEqual(['playlistTags', 'quickActions']);
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

  // Default writes no override, so without this nothing would record that the
  // climber chose: the tags' old key would be read as new at the next launch.
  it.each(CLIMB_ROW_PRESET_IDS)('marks the tags decided, and only the tags (%s)', (presetId) => {
    expect(withClimbRowPreset(EMPTY, presetId).legacy).toEqual({ playlistTags: 'decided' });
  });

  it('keeps baselines that were already read', () => {
    const read: StoredClimbRowDisplay = { ...EMPTY, legacy: { playlistTags: true, quickActions: false } };
    expect(withClimbRowPreset(read, 'default').legacy).toEqual({ playlistTags: true, quickActions: false });
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

describe('withClimbRowLegacyRead', () => {
  const read = (playlistTags: unknown, quickActions: unknown) => ({ playlistTags, quickActions });

  describe('a key that has never been read', () => {
    it('brings an explicit choice in and records what the key held', () => {
      expect(withClimbRowLegacyRead(EMPTY, read(true, false), NOTHING_CHANGED)).toEqual({
        version: 1,
        overrides: { playlistTags: true, quickActions: false },
        legacy: { playlistTags: true, quickActions: false },
      });
    });

    it('brings in an explicit choice that equals the default too', () => {
      const synced = withClimbRowLegacyRead(EMPTY, read(false, true), NOTHING_CHANGED);
      expect(synced.overrides).toEqual({ playlistTags: false, quickActions: true });
    });

    it.each([
      ['never written', null],
      ['undefined', undefined],
      ['a string', 'true'],
      ['a number', 1],
      ['an object', { enabled: true }],
    ])('brings nothing in for a key that is %s, and records it as empty', (_label, legacyValue) => {
      expect(withClimbRowLegacyRead(EMPTY, read(legacyValue, legacyValue), NOTHING_CHANGED)).toEqual({
        version: 1,
        overrides: {},
        legacy: { playlistTags: null, quickActions: null },
      });
    });

    it('does not replace a field changed this launch, and still brings the other in', () => {
      const changed = withClimbRowField(EMPTY, 'playlistTags', false);
      const synced = withClimbRowLegacyRead(changed, read(true, false), new Set<ClimbRowFieldId>(['playlistTags']));
      expect(synced.overrides).toEqual({ playlistTags: false, quickActions: false });
      expect(synced.legacy).toEqual({ playlistTags: true, quickActions: false });
    });
  });

  describe('a field decided here before its key was read', () => {
    it('keeps the choice at a later launch, when nothing was changed this launch', () => {
      const decided = withClimbRowField(EMPTY, 'quickActions', true);
      const synced = withClimbRowLegacyRead(decided, read(null, false), NOTHING_CHANGED);
      expect(displayOf(synced).quickActions).toBe(true);
      // From here on the key is known, so a later write by an older build shows.
      expect(synced.legacy).toEqual({ playlistTags: null, quickActions: false });
    });

    it('keeps a Default preset, which leaves no override to protect it', () => {
      const onDefault = withClimbRowPreset(EMPTY, 'default');
      expect(onDefault.overrides).toEqual({});
      const synced = withClimbRowLegacyRead(onDefault, read(true, null), NOTHING_CHANGED);
      expect(displayOf(synced).playlistTags).toBe(false);
      expect(synced.legacy).toEqual({ playlistTags: true, quickActions: null });
    });
  });

  describe('a key read before', () => {
    const known: StoredClimbRowDisplay = {
      version: 1,
      overrides: { playlistTags: true, quickActions: true },
      legacy: { playlistTags: true, quickActions: true },
    };

    it('changes nothing while the key still holds what it held', () => {
      expect(sameStoredClimbRowDisplay(withClimbRowLegacyRead(known, read(true, true), NOTHING_CHANGED), known)).toBe(
        true,
      );
    });

    it('leaves a choice made here alone when its key is unchanged, even if the two differ', () => {
      // A choice whose copy to the old key failed: the key still holds the older value.
      const unmirrored: StoredClimbRowDisplay = { ...known, overrides: { playlistTags: false, quickActions: true } };
      const synced = withClimbRowLegacyRead(unmirrored, read(true, true), NOTHING_CHANGED);
      expect(displayOf(synced).playlistTags).toBe(false);
    });

    it('brings in a value an older build wrote since', () => {
      const synced = withClimbRowLegacyRead(known, read(true, false), NOTHING_CHANGED);
      expect(synced.overrides).toEqual({ playlistTags: true, quickActions: false });
      expect(synced.legacy).toEqual({ playlistTags: true, quickActions: false });
    });

    it('brings in a first explicit choice an older build made in a key that held nothing', () => {
      const emptyKeys: StoredClimbRowDisplay = { ...EMPTY, legacy: { playlistTags: null, quickActions: null } };
      const synced = withClimbRowLegacyRead(emptyKeys, read(null, false), NOTHING_CHANGED);
      expect(synced.overrides).toEqual({ quickActions: false });
      expect(synced.legacy).toEqual({ playlistTags: null, quickActions: false });
    });

    it('does not let that value replace a field changed this launch', () => {
      const synced = withClimbRowLegacyRead(known, read(true, false), new Set<ClimbRowFieldId>(['quickActions']));
      expect(displayOf(synced).quickActions).toBe(true);
      expect(synced.legacy).toEqual({ playlistTags: true, quickActions: false });
    });

    it('keeps the choice when the key no longer holds one, and records that', () => {
      const synced = withClimbRowLegacyRead(known, read(null, true), NOTHING_CHANGED);
      expect(synced.overrides).toEqual({ playlistTags: true, quickActions: true });
      expect(synced.legacy).toEqual({ playlistTags: null, quickActions: true });
    });
  });

  it('keeps a remembered mix when the tags brought in leave the row on a preset', () => {
    // Default with nothing overriding the tags: the older choice lands, and
    // Default plus tags is the Everything preset.
    const onDefault: StoredClimbRowDisplay = { ...EMPTY, lastCustom: { ...CLIMB_ROW_PRESETS.default, setter: false } };
    const synced = withClimbRowLegacyRead(onDefault, read(true, null), NOTHING_CHANGED);
    expect(matchClimbRowPreset(displayOf(synced))).toBe('everything');
    expect(synced.lastCustom).toEqual({ ...CLIMB_ROW_PRESETS.default, setter: false });
  });
});

describe('withClimbRowLegacyMirrored', () => {
  it('records that the old key now holds the value written to it', () => {
    const decided = withClimbRowField(EMPTY, 'playlistTags', true);
    expect(decided.legacy).toEqual({ playlistTags: 'decided' });
    const mirrored = withClimbRowLegacyMirrored(decided, 'playlistTags', true);
    expect(mirrored.legacy).toEqual({ playlistTags: true });
    expect(mirrored.overrides).toEqual({ playlistTags: true });
  });

  it('touches only that key’s baseline, and keeps a remembered mix', () => {
    const before = withClimbRowPreset(withClimbRowField(EMPTY, 'setter', false), 'namesOnly');
    const mirrored = withClimbRowLegacyMirrored({ ...before, legacy: { quickActions: false } }, 'playlistTags', false);
    expect(mirrored.legacy).toEqual({ playlistTags: false, quickActions: false });
    expect(mirrored.overrides).toEqual(before.overrides);
    expect(mirrored.lastCustom).toEqual(before.lastCustom);
  });

  it('gives the same record back when the baseline already says so', () => {
    const known: StoredClimbRowDisplay = { ...EMPTY, legacy: { playlistTags: false } };
    expect(withClimbRowLegacyMirrored(known, 'playlistTags', false)).toBe(known);
  });
});

describe('withClimbRowDisplayReset', () => {
  it('goes back to the default row but keeps what is known of the old keys', () => {
    const before = withClimbRowPreset(
      withClimbRowLegacyRead(
        withClimbRowField(EMPTY, 'setter', false),
        { playlistTags: true, quickActions: false },
        NOTHING_CHANGED,
      ),
      'namesOnly',
    );
    expect(before.lastCustom).toBeDefined();

    const reset = withClimbRowDisplayReset(before);

    expect(reset).toEqual({ version: 1, overrides: {}, legacy: { playlistTags: true, quickActions: false } });
    // So the next launch finds the keys unchanged and brings nothing back.
    const nextLaunch = withClimbRowLegacyRead(reset, { playlistTags: true, quickActions: false }, NOTHING_CHANGED);
    expect(displayOf(nextLaunch)).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });

  it('is an empty record when the old keys were never read', () => {
    expect(withClimbRowDisplayReset(withClimbRowField(EMPTY, 'sends', false))).toEqual(EMPTY);
  });
});
