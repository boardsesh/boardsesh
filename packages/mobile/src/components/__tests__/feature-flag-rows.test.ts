import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildFeatureFlagRows,
  findStaleFeatureFlagOverrideKeys,
  resolveFeatureFlagOverrideAction,
} from '../feature-flag-rows';
import { selectedFeatureFlagLabel } from '../FeatureFlagsForm.logic';
import { parseObserveSampleRate } from '../../lib/observe-config';
import { FEATURE_FLAG_DEFINITIONS } from '../../providers/feature-flags-provider';

// `__DEV__` is a compile-time define here as well as under Metro, so the
// production rendering of a policy-controlled row is only reachable this way.
const build = vi.hoisted(() => ({ dev: false }));
vi.mock('../../lib/is-dev-build', () => ({ isDevBuild: () => build.dev }));

beforeEach(() => {
  build.dev = false;
});

function rowFor(
  key: string,
  overrides: Record<string, boolean | string> = {},
  baseFlags: Record<string, boolean | string> = {},
) {
  const row = buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, overrides, baseFlags).find(
    (candidate) => candidate.key === key,
  );
  if (!row) throw new Error(`no row for ${key}`);
  return row;
}

function captionFor(key: string, overrides: Record<string, boolean>, baseFlags: Record<string, boolean>): string {
  const row = buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, overrides, baseFlags).find(
    (candidate) => candidate.key === key,
  );
  expect(row).toBeDefined();
  return row?.effectiveLabel ?? '';
}

describe('buildFeatureFlagRows', () => {
  it('does not expose shipped spray walls despite stale remote flags or overrides', () => {
    const rows = buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, { 'spray-walls': false }, { 'spray-walls': false });
    expect(rows.some((row) => row.key === 'spray-walls')).toBe(false);
  });
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

  it('does not render a policy-controlled override as a forced choice on a store build', () => {
    // The provider drops this override outside a dev build, so a row that showed
    // 'on' here would be a toggle that lies about what the app is doing.
    const rows = buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, { 'donation-links-v2': true }, {});
    const row = rows.find((candidate) => candidate.key === 'donation-links-v2');

    expect(row?.choice).toBe('default');
    expect(row?.effectiveLabel).toBe(
      'Live default: not set · Effective: off · override ignored on this build (region-gated)',
    );
  });

  it('renders a policy-controlled override normally in a dev client', () => {
    build.dev = true;
    const rows = buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, { 'donation-links-v2': true }, {});
    const row = rows.find((candidate) => candidate.key === 'donation-links-v2');

    expect(row?.choice).toBe('on');
    expect(row?.effectiveLabel).toBe('Live default: not set · Effective: on');
  });

  it('gives every boolean row the Default/On/Off options, in order, as segments', () => {
    const rows = buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, {}, {});
    const row = rows.find((candidate) => candidate.key === 'garmin-watch');
    expect(row?.options.map((option) => option.key)).toEqual(['default', 'on', 'off']);
    expect(row?.control).toBe('segmented');
  });
});

// The variant select (rebuilt for #7000): Default plus one choice per declared
// variant, writing the variant string.
describe('buildFeatureFlagRows: multivariate flags', () => {
  it.each([
    ['first-connect-cta-arm', ['treatment', 'control'], 'segmented'],
    ['observe-sample-rate', ['1', '0.5', '0.25', '0.1', '0'], 'menu'],
  ] as const)('%s offers Default and each variant as a %s', (key, variants, control) => {
    const row = rowFor(key);
    expect(row.options.map((option) => option.label)).toEqual(['Default', ...variants]);
    expect(row.control).toBe(control);
    expect(row.choice).toBe('default');
  });

  it('every flag with variants renders them; no flag without variants does', () => {
    for (const definition of FEATURE_FLAG_DEFINITIONS) {
      const row = rowFor(definition.key);
      const variants: readonly string[] = 'variants' in definition ? definition.variants : [];
      if (variants.length > 0) expect(row.options).toHaveLength(variants.length + 1);
      else expect(row.options.map((option) => option.key)).toEqual(['default', 'on', 'off']);
    }
  });

  it('selects the forced variant and says what is live', () => {
    const row = rowFor(
      'first-connect-cta-arm',
      { 'first-connect-cta-arm': 'treatment' },
      { 'first-connect-cta-arm': 'control' },
    );
    expect(selectedFeatureFlagLabel(row.options, row.choice)).toBe('treatment');
    expect(row.effectiveLabel).toBe('Live default: control · Effective: treatment');
    expect(rowFor('first-connect-cta-arm').effectiveLabel).toBe('Live default: not set · Effective: default');
  });

  it('round-trips each choice through the override store', () => {
    for (const option of rowFor('observe-sample-rate').options) {
      const resolved = resolveFeatureFlagOverrideAction(option.key);
      const overrides: Record<string, boolean | string> =
        resolved.action === 'set' ? { 'observe-sample-rate': resolved.value } : {};
      expect(rowFor('observe-sample-rate', overrides).choice).toBe(option.key);
    }
  });

  it('writes a sample rate the observe config reads back', () => {
    const half = rowFor('observe-sample-rate').options.find((option) => option.label === '0.5');
    if (!half) throw new Error('no 0.5 choice');
    const resolved = resolveFeatureFlagOverrideAction(half.key);
    expect(resolved).toEqual({ action: 'set', value: '0.5' });
    expect(resolved.action === 'set' ? parseObserveSampleRate(resolved.value) : null).toBe(0.5);
  });

  it('renders an unknown variant or a leftover boolean at Default', () => {
    expect(rowFor('first-connect-cta-arm', { 'first-connect-cta-arm': 'retired' }).choice).toBe('default');
    expect(rowFor('observe-sample-rate', { 'observe-sample-rate': true }).choice).toBe('default');
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

  it('stores the variant string for a variant choice, even one named like a segment', () => {
    expect(resolveFeatureFlagOverrideAction('variant:bulb')).toEqual({ action: 'set', value: 'bulb' });
    expect(resolveFeatureFlagOverrideAction('variant:default')).toEqual({ action: 'set', value: 'default' });
    expect(resolveFeatureFlagOverrideAction('variant:off')).toEqual({ action: 'set', value: 'off' });
  });

  it('clears for a key no row offers', () => {
    expect(resolveFeatureFlagOverrideAction('treatment')).toEqual({ action: 'clear' });
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

  it('leaves every well-formed override alone, variants included', () => {
    expect(
      findStaleFeatureFlagOverrideKeys(FEATURE_FLAG_DEFINITIONS, {
        'garmin-watch': true,
        'strava-integration': false,
        'first-connect-cta-arm': 'treatment',
        'observe-sample-rate': '0.25',
      }),
    ).toEqual([]);
  });

  it('finds a boolean or an undeclared variant on a multivariate flag', () => {
    expect(
      findStaleFeatureFlagOverrideKeys(FEATURE_FLAG_DEFINITIONS, {
        'observe-sample-rate': true,
        'first-connect-cta-arm': 'retired',
      }),
    ).toEqual(['observe-sample-rate', 'first-connect-cta-arm']);
  });

  it('leaves a key the catalog no longer lists alone', () => {
    // A flag can be removed and restored across branches; "Reset all overrides"
    // already clears an inert entry, and dropping a tester's choice silently is
    // worse than keeping it.
    expect(findStaleFeatureFlagOverrideKeys(FEATURE_FLAG_DEFINITIONS, { 'retired-flag': true })).toEqual([]);
  });
});
