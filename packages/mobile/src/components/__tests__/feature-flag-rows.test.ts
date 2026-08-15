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
});
