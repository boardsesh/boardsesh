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
    expect(keys).not.toContain('offline-discovery-nudges');
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
});

// The branch FeatureFlagsScreen.handleSelect runs on every segment tap. It is
// extracted for the same reason buildFeatureFlagRows is: the screen renders a
// platform-split native @expo/ui form that a node test cannot mount.
describe('resolveFeatureFlagOverrideAction', () => {
  it('clears the override on the Default segment', () => {
    expect(resolveFeatureFlagOverrideAction('default')).toEqual({
      action: 'clear',
    });
  });

  it('stores a boolean for a plain on/off flag', () => {
    expect(resolveFeatureFlagOverrideAction('on')).toEqual({
      action: 'set',
      value: true,
    });
    expect(resolveFeatureFlagOverrideAction('off')).toEqual({
      action: 'set',
      value: false,
    });
  });
});

describe('findStaleFeatureFlagOverrideKeys', () => {
  it('finds a leftover variant string from when a flag was multivariate', () => {
    // Readers ignore it and the row already renders at Default — which is
    // exactly why the tester cannot clear it by hand: re-selecting the segment
    // it is already on fires nothing. So the screen migrates it on read.
    const overrides = { 'garmin-watch': 'plateau' };
    expect(
      buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, overrides, {}).find((row) => row.key === 'garmin-watch')?.choice,
    ).toBe('default');
    expect(findStaleFeatureFlagOverrideKeys(FEATURE_FLAG_DEFINITIONS, overrides)).toEqual(['garmin-watch']);
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
