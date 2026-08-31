import { describe, expect, it } from 'vitest';
import {
  buildFeatureFlagRows,
  findStaleFeatureFlagOverrideKeys,
  resolveFeatureFlagOverrideAction,
} from '../feature-flag-rows';
import { FEATURE_FLAG_DEFINITIONS } from '../../providers/feature-flags-provider';

function captionFor(key: string, overrides: Record<string, boolean>, baseFlags: Record<string, boolean>): string {
  const row = buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, overrides, baseFlags).find(
    (candidate) => candidate.key === key,
  );
  expect(row).toBeDefined();
  return row?.effectiveLabel ?? '';
}

describe('buildFeatureFlagRows', () => {
  it('does not expose permanently shipped offline capabilities as overrides', () => {
    const keys = FEATURE_FLAG_DEFINITIONS.map((definition) => definition.key);
    expect(keys).not.toContain('offline-board-downloads');
    expect(keys).not.toContain('offline-snapshot-bootstrap-v2');
    expect(keys).not.toContain('offline-download-progress');
    expect(keys).not.toContain('offline-download-task-api');
    expect(keys).not.toContain('offline-download-background-session');
  });

  it('keeps ordinary flags on `=== true` semantics', () => {
    expect(captionFor('garmin-watch', {}, {})).toBe('Live default: not set · Effective: off');
    expect(captionFor('garmin-watch', { 'garmin-watch': true }, {})).toBe('Live default: not set · Effective: on');
  });

  it('maps the override to the segmented choice', () => {
    const rows = buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, { 'garmin-watch': false }, {});
    expect(rows.find((row) => row.key === 'garmin-watch')?.choice).toBe('off');
    expect(rows.find((row) => row.key === 'strava-integration')?.choice).toBe('default');
  });

  it('gives every boolean row the Default/On/Off options, in order', () => {
    const rows = buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, {}, {});
    const row = rows.find((candidate) => candidate.key === 'garmin-watch');
    expect(row?.options.map((option) => option.key)).toEqual(['default', 'on', 'off']);
  });

  describe('a multivariate flag', () => {
    function rowFor(overrides: Record<string, boolean | string>, baseFlags: Record<string, boolean | string>) {
      const row = buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, overrides, baseFlags).find(
        (candidate) => candidate.key === 'board-glow-falloff',
      );
      expect(row).toBeDefined();
      return row!;
    }

    it('renders Default plus each declared variant, in order', () => {
      expect(rowFor({}, {}).options.map((option) => option.key)).toEqual(['default', 'soft', 'plateau']);
    });

    it('defaults to the "default" choice with no override', () => {
      expect(rowFor({}, {}).choice).toBe('default');
    });

    it('takes the override as the choice when it is a declared variant', () => {
      expect(rowFor({ 'board-glow-falloff': 'plateau' }, {}).choice).toBe('plateau');
    });

    it('shows the resolved variant in the effective label, not on/off', () => {
      expect(rowFor({}, { 'board-glow-falloff': 'soft' }).effectiveLabel).toBe('Live default: soft · Effective: soft');
      expect(rowFor({ 'board-glow-falloff': 'plateau' }, { 'board-glow-falloff': 'soft' }).effectiveLabel).toBe(
        'Live default: soft · Effective: plateau',
      );
    });

    it('reads "not set" for both halves when nothing has resolved', () => {
      expect(rowFor({}, {}).effectiveLabel).toBe('Live default: not set · Effective: not set');
    });

    it('ignores a base value outside the declared variant set', () => {
      expect(rowFor({}, { 'board-glow-falloff': 'not-a-real-variant' }).effectiveLabel).toBe(
        'Live default: not set · Effective: not set',
      );
    });
  });
});

// The branch FeatureFlagsScreen.handleSelect runs on every segment tap. It is
// extracted for the same reason buildFeatureFlagRows is: the screen renders a
// platform-split native @expo/ui form that a node test cannot mount.
describe('resolveFeatureFlagOverrideAction', () => {
  it('clears the override on the Default segment', () => {
    expect(resolveFeatureFlagOverrideAction(FEATURE_FLAG_DEFINITIONS, 'garmin-watch', 'default')).toEqual({
      action: 'clear',
    });
  });

  it('stores a boolean for a plain on/off flag', () => {
    expect(resolveFeatureFlagOverrideAction(FEATURE_FLAG_DEFINITIONS, 'garmin-watch', 'on')).toEqual({
      action: 'set',
      value: true,
    });
    expect(resolveFeatureFlagOverrideAction(FEATURE_FLAG_DEFINITIONS, 'garmin-watch', 'off')).toEqual({
      action: 'set',
      value: false,
    });
  });

  it('stores the variant string verbatim for a multivariate flag', () => {
    expect(resolveFeatureFlagOverrideAction(FEATURE_FLAG_DEFINITIONS, 'board-glow-falloff', 'soft')).toEqual({
      action: 'set',
      value: 'soft',
    });
    expect(resolveFeatureFlagOverrideAction(FEATURE_FLAG_DEFINITIONS, 'board-glow-falloff', 'plateau')).toEqual({
      action: 'set',
      value: 'plateau',
    });
  });

  it('keys the branch off the definition, not the shape of the choice', () => {
    // 'plateau' is a legal variant of board-glow-falloff; on a boolean flag the
    // same string could only ever mean "not 'on'". Nothing about the choice
    // string decides which kind of value gets written.
    expect(resolveFeatureFlagOverrideAction(FEATURE_FLAG_DEFINITIONS, 'board-glow-falloff', 'plateau')).toEqual({
      action: 'set',
      value: 'plateau',
    });
    expect(resolveFeatureFlagOverrideAction(FEATURE_FLAG_DEFINITIONS, 'garmin-watch', 'plateau')).toEqual({
      action: 'set',
      value: false,
    });
  });
});

describe('findStaleFeatureFlagOverrideKeys', () => {
  it('finds a legacy boolean left on a flag that has since become multivariate', () => {
    // The row already renders at Default (buildFeatureFlagRows ignores a
    // non-variant override), which is exactly why the tester cannot clear it by
    // hand — re-selecting the segment it is already on fires nothing.
    const overrides = { 'board-glow-falloff': true };
    expect(
      buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, overrides, {}).find((row) => row.key === 'board-glow-falloff')
        ?.choice,
    ).toBe('default');
    expect(findStaleFeatureFlagOverrideKeys(FEATURE_FLAG_DEFINITIONS, overrides)).toEqual(['board-glow-falloff']);
  });

  it('finds a variant this build no longer declares', () => {
    expect(
      findStaleFeatureFlagOverrideKeys(FEATURE_FLAG_DEFINITIONS, { 'board-glow-falloff': 'retired-variant' }),
    ).toEqual(['board-glow-falloff']);
  });

  it('finds a string left on a plain boolean flag', () => {
    expect(findStaleFeatureFlagOverrideKeys(FEATURE_FLAG_DEFINITIONS, { 'garmin-watch': 'on' })).toEqual([
      'garmin-watch',
    ]);
  });

  it('leaves every well-formed override alone', () => {
    expect(
      findStaleFeatureFlagOverrideKeys(FEATURE_FLAG_DEFINITIONS, {
        'garmin-watch': true,
        'strava-integration': false,
        'board-glow-falloff': 'soft',
      }),
    ).toEqual([]);
  });

  it('leaves a key the catalog no longer lists alone', () => {
    // A flag can be removed and restored across branches; "Reset all overrides"
    // already clears an inert entry, and dropping a tester's choice silently is
    // worse than keeping it.
    expect(findStaleFeatureFlagOverrideKeys(FEATURE_FLAG_DEFINITIONS, { 'retired-flag': true })).toEqual([]);
  });
});
