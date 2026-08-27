import { describe, expect, it } from 'vitest';
import { buildFeatureFlagRows } from '../feature-flag-rows';
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
        (candidate) => candidate.key === 'board-render-mode-default',
      );
      expect(row).toBeDefined();
      return row!;
    }

    it('renders Default plus each declared variant, in order', () => {
      expect(rowFor({}, {}).options.map((option) => option.key)).toEqual(['default', 'classic', 'boardsesh']);
    });

    it('defaults to the "default" choice with no override', () => {
      expect(rowFor({}, {}).choice).toBe('default');
    });

    it('takes the override as the choice when it is a declared variant', () => {
      expect(rowFor({ 'board-render-mode-default': 'boardsesh' }, {}).choice).toBe('boardsesh');
    });

    it('shows the resolved variant in the effective label, not on/off', () => {
      expect(rowFor({}, { 'board-render-mode-default': 'classic' }).effectiveLabel).toBe(
        'Live default: classic · Effective: classic',
      );
      expect(
        rowFor({ 'board-render-mode-default': 'boardsesh' }, { 'board-render-mode-default': 'classic' }).effectiveLabel,
      ).toBe('Live default: classic · Effective: boardsesh');
    });

    it('reads "not set" for both halves when nothing has resolved', () => {
      expect(rowFor({}, {}).effectiveLabel).toBe('Live default: not set · Effective: not set');
    });

    it('ignores a base value outside the declared variant set', () => {
      expect(rowFor({}, { 'board-render-mode-default': 'not-a-real-variant' }).effectiveLabel).toBe(
        'Live default: not set · Effective: not set',
      );
    });
  });
});
