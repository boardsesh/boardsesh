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
  it('reports an unresolved offline flag as effectively on', () => {
    // The regression: `override ?? base ?? false` collapsed "unset" into an
    // explicit false, so the screen said "off" for a flag that was on.
    expect(captionFor('offline-board-downloads', {}, {})).toBe('Live default: not set · Effective: on');
  });

  it('reports an explicitly disabled offline flag as off', () => {
    expect(captionFor('offline-board-downloads', {}, { 'offline-board-downloads': false })).toBe(
      'Live default: off · Effective: off',
    );
  });

  it('lets a tester override off beat an unresolved offline flag', () => {
    expect(captionFor('offline-board-downloads', { 'offline-board-downloads': false }, {})).toBe(
      'Live default: not set · Effective: off',
    );
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
});
