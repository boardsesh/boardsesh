import { describe, expect, it } from 'vitest';
import {
  CLIMB_ROW_FIELD_IDS,
  CLIMB_ROW_LEGACY_FIELD_IDS,
  CLIMB_ROW_LEGACY_KEY_DEFAULTS,
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
  type ClimbRowPresetFieldId,
  type StoredClimbRowDisplay,
} from '../climb-row-display';

const EMPTY: StoredClimbRowDisplay = { version: 1, overrides: {} };

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
      progress: false,
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

  it('keeps a baseline for each old key: a boolean, or null for a key with no choice in it', () => {
    for (const baseline of [true, false, null]) {
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
      legacy: { playlistTags: 'true', quickActions: 'decided', thumbnail: true, glitter: false },
    });
    expect(stored).toEqual(EMPTY);
    for (const legacy of ['decided', null, [true], 7]) {
      expect(sanitiseStoredClimbRowDisplay({ version: 1, overrides: {}, legacy })).toEqual(EMPTY);
    }
  });

  it('keeps a pending value for each old key, booleans only', () => {
    for (const owed of [true, false]) {
      const legacyPending = { playlistTags: owed, quickActions: !owed };
      expect(sanitiseStoredClimbRowDisplay({ version: 1, overrides: {}, legacyPending })).toEqual({
        ...EMPTY,
        legacyPending,
      });
    }
    const stored = sanitiseStoredClimbRowDisplay({
      version: 1,
      overrides: {},
      // `null` is a baseline, not something that can be owed to a key.
      legacyPending: { playlistTags: null, quickActions: 'false', thumbnail: true },
    });
    expect(stored).toEqual(EMPTY);
    for (const legacyPending of [true, null, [true], 'playlistTags']) {
      expect(sanitiseStoredClimbRowDisplay({ version: 1, overrides: {}, legacyPending })).toEqual(EMPTY);
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
    const produced = withClimbRowLegacyRead(
      withClimbRowPreset(
        withClimbRowField(withClimbRowField(EMPTY, 'setter', false), 'quickActions', false),
        'everything',
      ),
      { playlistTags: null, quickActions: true },
    );
    // Every optional part is in play: a remembered mix, a baseline and a pending value.
    expect(produced.lastCustom).toBeDefined();
    expect(produced.legacy).toBeDefined();
    expect(produced.legacyPending).toBeDefined();
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
      { version: 1, overrides: {}, legacy: { quickActions: false } },
    ],
    ['a key read as empty versus never read', EMPTY, { version: 1, overrides: {}, legacy: { playlistTags: null } }],
    ['a pending value', EMPTY, { version: 1, overrides: {}, legacyPending: { playlistTags: false } }],
    [
      'a pending value’s value',
      { version: 1, overrides: {}, legacyPending: { playlistTags: true } },
      { version: 1, overrides: {}, legacyPending: { playlistTags: false } },
    ],
    [
      'which key a value is pending for',
      { version: 1, overrides: {}, legacyPending: { playlistTags: true } },
      { version: 1, overrides: {}, legacyPending: { quickActions: true } },
    ],
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

  it('owes nothing to an old key for a field that never had one', () => {
    expect(withClimbRowField(EMPTY, 'sends', false)).toEqual({ version: 1, overrides: { sends: false } });
    const known: StoredClimbRowDisplay = {
      ...EMPTY,
      legacy: { playlistTags: true, quickActions: null },
      legacyPending: { quickActions: false },
    };
    const flipped = withClimbRowField(known, 'sends', false);
    expect(flipped.legacy).toEqual({ playlistTags: true, quickActions: null });
    expect(flipped.legacyPending).toEqual({ quickActions: false });
  });

  it.each(CLIMB_ROW_LEGACY_FIELD_IDS)(
    'owes the new value of %s to its old key, in the same record as the choice',
    (fieldId) => {
      for (const value of [true, false]) {
        const decided = withClimbRowField(EMPTY, fieldId, value);
        expect(decided).toEqual({ version: 1, overrides: { [fieldId]: value }, legacyPending: { [fieldId]: value } });
      }
    },
  );

  it('owes it whatever the baseline says: a baseline can be out of date until the keys are read', () => {
    const known: StoredClimbRowDisplay = { ...EMPTY, legacy: { quickActions: false } };
    const decided = withClimbRowField(known, 'quickActions', false);
    expect(decided.legacy).toEqual({ quickActions: false });
    expect(decided.legacyPending).toEqual({ quickActions: false });
  });

  it('replaces a value still owed from an earlier choice, and leaves the other key’s alone', () => {
    const owing: StoredClimbRowDisplay = { ...EMPTY, legacyPending: { playlistTags: true, quickActions: false } };
    expect(withClimbRowField(owing, 'playlistTags', false).legacyPending).toEqual({
      playlistTags: false,
      quickActions: false,
    });
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
  it.each(CLIMB_ROW_PRESET_IDS)(
    'owes the tags it sets to their old key, and nothing for quick actions (%s)',
    (presetId) => {
      expect(withClimbRowPreset(EMPTY, presetId).legacyPending).toEqual({
        playlistTags: CLIMB_ROW_PRESETS[presetId].playlistTags,
      });
    },
  );

  it('keeps the baselines, and a quick-actions value still owed', () => {
    const known: StoredClimbRowDisplay = {
      ...EMPTY,
      legacy: { playlistTags: true, quickActions: false },
      legacyPending: { quickActions: true },
    };
    const applied = withClimbRowPreset(known, 'default');
    expect(applied.legacy).toEqual({ playlistTags: true, quickActions: false });
    expect(applied.legacyPending).toEqual({ playlistTags: false, quickActions: true });
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

  it('owes the restored tags to their old key, replacing what the preset owed', () => {
    const onPreset = withClimbRowPreset(handMade, 'namesOnly');
    expect(onPreset.legacyPending).toEqual({ playlistTags: false });
    expect(withClimbRowLastCustomRestored(onPreset).legacyPending).toEqual({ playlistTags: true });
  });
});

describe('what an older build shows for an old key with no choice in it', () => {
  it('is tags off and the quick-actions button on', () => {
    expect(CLIMB_ROW_LEGACY_KEY_DEFAULTS).toEqual({ playlistTags: false, quickActions: true });
  });
});

describe('withClimbRowLegacyRead', () => {
  const read = (playlistTags: unknown, quickActions: unknown) => ({ playlistTags, quickActions });

  describe('a key that has never been read', () => {
    it('brings an explicit choice in and records what the key held', () => {
      expect(withClimbRowLegacyRead(EMPTY, read(true, false))).toEqual({
        version: 1,
        overrides: { playlistTags: true, quickActions: false },
        legacy: { playlistTags: true, quickActions: false },
      });
    });

    it('brings in an explicit choice that equals the default too', () => {
      const synced = withClimbRowLegacyRead(EMPTY, read(false, true));
      expect(synced.overrides).toEqual({ playlistTags: false, quickActions: true });
      expect(synced.legacyPending).toBeUndefined();
    });

    it.each([
      ['never written', null],
      ['undefined', undefined],
      ['a string', 'true'],
      ['a number', 1],
      ['an object', { enabled: true }],
    ])('brings nothing in for a key that is %s, and records it as empty', (_label, legacyValue) => {
      expect(withClimbRowLegacyRead(EMPTY, read(legacyValue, legacyValue))).toEqual({
        version: 1,
        overrides: {},
        legacy: { playlistTags: null, quickActions: null },
      });
    });

    it('asks for no write for a climber who never chose: both sides show the default', () => {
      const synced = withClimbRowLegacyRead(EMPTY, read(null, null));
      expect(synced.legacyPending).toBeUndefined();
      const again = withClimbRowLegacyRead(synced, read(null, null));
      expect(sameStoredClimbRowDisplay(again, synced)).toBe(true);
    });
  });

  describe('a key read before, with nothing pending for it', () => {
    const known: StoredClimbRowDisplay = {
      version: 1,
      overrides: { playlistTags: true, quickActions: true },
      legacy: { playlistTags: true, quickActions: true },
    };

    it('changes nothing while the key still holds what it held', () => {
      expect(sameStoredClimbRowDisplay(withClimbRowLegacyRead(known, read(true, true)), known)).toBe(true);
    });

    it('brings in a value an older build wrote since', () => {
      expect(withClimbRowLegacyRead(known, read(true, false))).toEqual({
        version: 1,
        overrides: { playlistTags: true, quickActions: false },
        legacy: { playlistTags: true, quickActions: false },
      });
    });

    it('brings in a first explicit choice an older build made in a key that held nothing', () => {
      const emptyKeys: StoredClimbRowDisplay = { ...EMPTY, legacy: { playlistTags: null, quickActions: null } };
      expect(withClimbRowLegacyRead(emptyKeys, read(null, false))).toEqual({
        version: 1,
        overrides: { quickActions: false },
        legacy: { playlistTags: null, quickActions: false },
      });
    });

    it('keeps the choice when the key no longer holds one, and owes it back to the key', () => {
      // The key was cleared from outside; an older build would now show tags off.
      const synced = withClimbRowLegacyRead(known, read(null, true));
      expect(synced.overrides).toEqual({ playlistTags: true, quickActions: true });
      expect(synced.legacy).toEqual({ playlistTags: null, quickActions: true });
      expect(synced.legacyPending).toEqual({ playlistTags: true });
    });
  });

  describe('healing a key that does not show what this record shows', () => {
    // A choice made here whose write was never recorded at all: the state a
    // build from before pending values could leave behind.
    const unmirrored: StoredClimbRowDisplay = {
      version: 1,
      overrides: { playlistTags: false },
      legacy: { playlistTags: true, quickActions: null },
    };

    it('owes the value shown here to a key that holds another, without touching the choice', () => {
      const synced = withClimbRowLegacyRead(unmirrored, read(true, null));
      expect(displayOf(synced).playlistTags).toBe(false);
      expect(synced.legacy).toEqual({ playlistTags: true, quickActions: null });
      expect(synced.legacyPending).toEqual({ playlistTags: false });
    });

    it('measures an empty key by what an older build shows for it, not by null', () => {
      // Quick actions off here, key empty: an older build shows the button.
      const hidden: StoredClimbRowDisplay = {
        ...EMPTY,
        overrides: { quickActions: false },
        legacy: { quickActions: null },
      };
      expect(withClimbRowLegacyRead(hidden, read(null, null)).legacyPending).toEqual({ quickActions: false });
      // Tags off here, key empty: an older build shows them off too. Nothing owed.
      const tagsOff: StoredClimbRowDisplay = {
        ...EMPTY,
        overrides: { playlistTags: false },
        legacy: { playlistTags: null },
      };
      expect(withClimbRowLegacyRead(tagsOff, read(null, null)).legacyPending).toBeUndefined();
    });

    it('owes nothing once a value an older build wrote has been brought in', () => {
      const synced = withClimbRowLegacyRead(unmirrored, read(false, false));
      expect(synced.overrides).toEqual({ playlistTags: false, quickActions: false });
      expect(synced.legacyPending).toBeUndefined();
    });
  });

  describe('a key with a value pending for it', () => {
    const owing: StoredClimbRowDisplay = {
      version: 1,
      overrides: { playlistTags: false },
      legacy: { playlistTags: true, quickActions: null },
      legacyPending: { playlistTags: false },
    };

    it('reads its own value back as a write that landed: known, and no longer owed', () => {
      expect(withClimbRowLegacyRead(owing, read(false, null))).toEqual({
        version: 1,
        overrides: { playlistTags: false },
        legacy: { playlistTags: false, quickActions: null },
      });
    });

    it('never lets what it reads replace the choice, and keeps owing it', () => {
      // The write failed or was cut off: the key still holds the older value.
      const synced = withClimbRowLegacyRead(owing, read(true, null));
      expect(displayOf(synced).playlistTags).toBe(false);
      expect(synced.legacy).toEqual({ playlistTags: true, quickActions: null });
      expect(synced.legacyPending).toEqual({ playlistTags: false });
    });

    it('treats a value it never wrote last as its own overtaken write, not an older build’s choice', () => {
      // Key and baseline false; on, then off again before the first write
      // returned; the first write reached the disk and the app died.
      const overtaken: StoredClimbRowDisplay = {
        version: 1,
        overrides: { playlistTags: false },
        legacy: { playlistTags: false, quickActions: null },
        legacyPending: { playlistTags: false },
      };
      const synced = withClimbRowLegacyRead(overtaken, read(true, null));
      expect(displayOf(synced).playlistTags).toBe(false);
      expect(synced.legacyPending).toEqual({ playlistTags: false });
    });

    it('keeps owing a value an empty key already seems to show, until it is really written', () => {
      // Default applied before the key was read; the write failed; the key is empty.
      const onDefault = withClimbRowPreset(EMPTY, 'default');
      expect(onDefault).toEqual({ version: 1, overrides: {}, legacyPending: { playlistTags: false } });
      const synced = withClimbRowLegacyRead(onDefault, read(null, null));
      expect(synced.legacyPending).toEqual({ playlistTags: false });
    });

    it('keeps a Default preset, which leaves no override to protect it', () => {
      const synced = withClimbRowLegacyRead(withClimbRowPreset(EMPTY, 'default'), read(true, null));
      expect(displayOf(synced).playlistTags).toBe(false);
      expect(synced.legacy).toEqual({ playlistTags: true, quickActions: null });
      expect(synced.legacyPending).toEqual({ playlistTags: false });
    });

    it('still brings the other key’s value in', () => {
      const synced = withClimbRowLegacyRead(owing, read(true, false));
      expect(synced.overrides).toEqual({ playlistTags: false, quickActions: false });
    });
  });

  it('keeps a remembered mix when the tags brought in leave the row on a preset', () => {
    // Default with nothing overriding the tags: the older choice lands, and
    // Default plus tags is the Everything preset.
    const onDefault: StoredClimbRowDisplay = {
      ...EMPTY,
      overrides: { progress: true },
      lastCustom: { ...CLIMB_ROW_PRESETS.default, setter: false },
    };
    const synced = withClimbRowLegacyRead(onDefault, read(true, null));
    expect(matchClimbRowPreset(displayOf(synced))).toBe('everything');
    expect(synced.lastCustom).toEqual({ ...CLIMB_ROW_PRESETS.default, setter: false });
  });
});

describe('withClimbRowLegacyMirrored', () => {
  const decided = withClimbRowField(EMPTY, 'playlistTags', true);

  it('confirms the pending value: the key is known to hold it and nothing is owed', () => {
    expect(decided.legacyPending).toEqual({ playlistTags: true });
    expect(withClimbRowLegacyMirrored(decided, 'playlistTags', true)).toEqual({
      version: 1,
      overrides: { playlistTags: true },
      legacy: { playlistTags: true },
    });
  });

  it('leaves the record exactly as it is when a newer choice has replaced the one written', () => {
    const flippedBack = withClimbRowField(decided, 'playlistTags', false);
    expect(withClimbRowLegacyMirrored(flippedBack, 'playlistTags', true)).toBe(flippedBack);
  });

  it('leaves the record as it is when nothing was pending for that key', () => {
    const known: StoredClimbRowDisplay = { ...EMPTY, legacy: { playlistTags: false } };
    expect(withClimbRowLegacyMirrored(known, 'playlistTags', true)).toBe(known);
    expect(withClimbRowLegacyMirrored(known, 'playlistTags', false)).toBe(known);
  });

  it('touches only that key, and keeps a remembered mix', () => {
    const before = withClimbRowField(
      withClimbRowPreset(withClimbRowField(EMPTY, 'setter', false), 'namesOnly'),
      'quickActions',
      false,
    );
    expect(before.legacyPending).toEqual({ playlistTags: false, quickActions: false });
    const mirrored = withClimbRowLegacyMirrored(before, 'playlistTags', false);
    expect(mirrored.legacy).toEqual({ playlistTags: false });
    expect(mirrored.legacyPending).toEqual({ quickActions: false });
    expect(mirrored.overrides).toEqual(before.overrides);
    expect(mirrored.lastCustom).toEqual(before.lastCustom);
  });
});

describe('withClimbRowDisplayReset', () => {
  it('goes back to the default row, keeps the baselines and owes both old keys their default', () => {
    const before = withClimbRowPreset(
      withClimbRowLegacyRead(withClimbRowField(EMPTY, 'setter', false), { playlistTags: true, quickActions: false }),
      'namesOnly',
    );
    expect(before.lastCustom).toBeDefined();

    const reset = withClimbRowDisplayReset(before);

    expect(reset).toEqual({
      version: 1,
      overrides: {},
      legacy: { playlistTags: true, quickActions: false },
      legacyPending: { playlistTags: false, quickActions: true },
    });
  });

  it('owes both keys their default even when the baselines say they already show it', () => {
    // A baseline can be out of date at this point, and a write may be on its way.
    const known: StoredClimbRowDisplay = { ...EMPTY, legacy: { playlistTags: false, quickActions: true } };
    expect(withClimbRowDisplayReset(known).legacyPending).toEqual({ playlistTags: false, quickActions: true });
    expect(withClimbRowDisplayReset(EMPTY).legacyPending).toEqual({ playlistTags: false, quickActions: true });
  });

  it('replaces a value that was still owed with the default', () => {
    // The climber turned tags on and the button off, neither write landed, then reset.
    const owing: StoredClimbRowDisplay = {
      ...EMPTY,
      overrides: { playlistTags: true, quickActions: false },
      legacyPending: { playlistTags: true, quickActions: false },
    };
    expect(withClimbRowDisplayReset(owing).legacyPending).toEqual({ playlistTags: false, quickActions: true });
  });

  it('holds against a read of the old keys that lands afterwards, whatever it finds', () => {
    const reset = withClimbRowDisplayReset({ ...EMPTY, overrides: { playlistTags: true, quickActions: false } });
    for (const found of [
      { playlistTags: true, quickActions: false },
      { playlistTags: null, quickActions: null },
      { playlistTags: false, quickActions: true },
    ]) {
      expect(displayOf(withClimbRowLegacyRead(reset, found))).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    }
  });
});

// The four ways the old key and this record can come apart, each followed to the
// launch where they agree again. `key` is what is on disk, as a build that only
// knows the old key would read it.
describe('timelines for one old key', () => {
  type Phone = { key: boolean | null; record: StoredClimbRowDisplay };
  const tags = (phone: Phone) => displayOf(phone.record).playlistTags;
  const shownByOlderBuild = (phone: Phone) => phone.key ?? CLIMB_ROW_LEGACY_KEY_DEFAULTS.playlistTags;

  /** A launch: the key is read, and whatever is then pending is written and confirmed. */
  function launch(phone: Phone, writesLand = true): Phone {
    let record = withClimbRowLegacyRead(phone.record, { playlistTags: phone.key, quickActions: null });
    let key = phone.key;
    const owed = record.legacyPending?.playlistTags;
    if (owed !== undefined && writesLand) {
      key = owed;
      record = withClimbRowLegacyMirrored(record, 'playlistTags', owed);
    }
    return { key, record };
  }

  it('a write that fails, or is cut off, is made again at the next launch', () => {
    const synced = launch({ key: true, record: EMPTY });
    expect(tags(synced)).toBe(true);

    // Tags off; the write to the old key never lands.
    const afterChoice: Phone = { key: true, record: withClimbRowField(synced.record, 'playlistTags', false) };
    expect(shownByOlderBuild(afterChoice)).toBe(true);

    // A launch where the write fails again: the choice holds, and stays owed.
    const stillFailing = launch(afterChoice, false);
    expect(tags(stillFailing)).toBe(false);
    expect(stillFailing.record.legacyPending).toEqual({ playlistTags: false });

    // A launch where it lands: a rollback now shows what the climber chose.
    const healed = launch(stillFailing);
    expect(tags(healed)).toBe(false);
    expect(shownByOlderBuild(healed)).toBe(false);
    expect(healed.record.legacy?.playlistTags).toBe(false);
    expect(healed.record.legacyPending).toBeUndefined();
  });

  it('an overtaken write that lands alone does not undo the last choice', () => {
    const synced = launch({ key: false, record: EMPTY });

    // On, then off before the first write returned. The first write reached the
    // disk; the app died before the second, and before anything was confirmed.
    const twoFlips = withClimbRowField(withClimbRowField(synced.record, 'playlistTags', true), 'playlistTags', false);
    const died: Phone = { key: true, record: twoFlips };

    const relaunched = launch(died);
    expect(tags(relaunched)).toBe(false);
    expect(shownByOlderBuild(relaunched)).toBe(false);
    expect(relaunched.record.legacyPending).toBeUndefined();
  });

  it('a choice made on an older build in between still arrives', () => {
    const preview = launch({ key: null, record: EMPTY });
    expect(tags(preview)).toBe(false);

    const shipped = launch({ key: true, record: preview.record });
    expect(tags(shipped)).toBe(true);
    expect(shipped.record.legacyPending).toBeUndefined();
  });

  it('a reset holds across a launch, and reaches the old key', () => {
    const synced = launch({ key: true, record: EMPTY });
    expect(tags(synced)).toBe(true);

    const reset: Phone = { key: true, record: withClimbRowDisplayReset(synced.record) };
    const relaunched = launch(reset);

    expect(tags(relaunched)).toBe(false);
    expect(shownByOlderBuild(relaunched)).toBe(false);
  });
});
