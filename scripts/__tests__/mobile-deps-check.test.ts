import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkMobileDeps, readBundledNativeModules, readExcludeList, type DepViolation } from '../mobile-deps-check';

function violationFor(violations: DepViolation[], name: string): DepViolation | undefined {
  return violations.find((violation) => violation.package === name);
}

describe('checkMobileDeps', () => {
  it('passes an exact pin that sits inside the bundled range', () => {
    const { checked, violations } = checkMobileDeps(
      { 'expo-haptics': '56.0.3' },
      [],
      { 'expo-haptics': '~56.0.3' },
      { 'expo-haptics': '56.0.3' },
    );

    expect(checked).toBe(1);
    expect(violations).toEqual([]);
  });

  it('flags an exact pin that falls outside the bundled range', () => {
    // Installed matches declared, so only the range-alignment check fires.
    const { violations } = checkMobileDeps(
      { 'expo-haptics': '55.0.0' },
      [],
      { 'expo-haptics': '~56.0.3' },
      { 'expo-haptics': '55.0.0' },
    );

    expect(violations).toHaveLength(1);
    expect(violations[0].package).toBe('expo-haptics');
    expect(violations[0].reason).toContain("does not satisfy the SDK's bundled range");
  });

  it('passes a range pin that is string-equal to the bundled range', () => {
    const { violations } = checkMobileDeps(
      { '@expo/ui': '~56.0.18' },
      [],
      { '@expo/ui': '~56.0.18' },
      { '@expo/ui': '56.0.18' },
    );

    expect(violations).toEqual([]);
  });

  it('flags a range pin that differs from the bundled range string', () => {
    const { violations } = checkMobileDeps(
      { '@expo/ui': '^56.0.18' },
      [],
      { '@expo/ui': '~56.0.18' },
      { '@expo/ui': '56.0.18' },
    );

    const violation = violationFor(violations, '@expo/ui');
    expect(violation).toBeDefined();
    expect(violation?.reason).toContain("pin exactly or match the SDK's range string");
  });

  it('exempts excluded packages from the bundled-range check', () => {
    const { checked, violations } = checkMobileDeps(
      { '@sentry/react-native': '6.22.0' },
      ['@sentry/react-native'],
      { '@sentry/react-native': '~7.11.0' },
      { '@sentry/react-native': '6.22.0' },
    );

    // Deliberately deviates from the SDK pin: no rule-1 violation and no
    // rule-1 "checked" credit, but rule 2 ran (installed matches declared).
    expect(checked).toBe(0);
    expect(violations).toEqual([]);
  });

  it('still flags lockfile drift on an excluded package', () => {
    // Exclusion means "deviates from the SDK pin", not "exempt from drift":
    // the hand-pinned version must still be what is actually installed.
    const { violations } = checkMobileDeps(
      { '@sentry/react-native': '6.22.0' },
      ['@sentry/react-native'],
      { '@sentry/react-native': '~7.11.0' },
      { '@sentry/react-native': '6.23.1' },
    );

    const violation = violationFor(violations, '@sentry/react-native');
    expect(violation).toBeDefined();
    expect(violation?.reason).toContain('lockfile drift');
    expect(violation?.reason).not.toContain('bundled range');
  });

  it('skips excluded packages the SDK does not track at all (typescript-style entries)', () => {
    // typescript is in expo.install.exclude but absent from the bundled map,
    // so the bundled-map gate skips it entirely — even rule 2 (it is not even
    // in the installedVersions map here, and no violation surfaces).
    const { checked, violations } = checkMobileDeps(
      { typescript: '~6.0.3' },
      ['typescript'],
      { 'expo-haptics': '~56.0.3' },
      {},
    );

    expect(checked).toBe(0);
    expect(violations).toEqual([]);
  });

  it('skips packages the installed SDK does not track pins for', () => {
    const { checked, violations } = checkMobileDeps(
      { 'not-a-native-module': '1.0.0' },
      [],
      { 'some-other-module': '1.0.0' },
      { 'not-a-native-module': '1.0.0' },
    );

    expect(checked).toBe(0);
    expect(violations).toEqual([]);
  });

  it('flags installed-version drift even when the declared range aligns with the SDK', () => {
    const { violations } = checkMobileDeps(
      { 'expo-haptics': '~56.0.3' },
      [],
      { 'expo-haptics': '~56.0.3' },
      { 'expo-haptics': '55.9.0' },
    );

    const violation = violationFor(violations, 'expo-haptics');
    expect(violation).toBeDefined();
    expect(violation?.reason).toContain('lockfile drift');
  });

  it('flags a package that is declared but not installed', () => {
    const { violations } = checkMobileDeps({ 'expo-haptics': '~56.0.3' }, [], { 'expo-haptics': '~56.0.3' }, {});

    const violation = violationFor(violations, 'expo-haptics');
    expect(violation).toBeDefined();
    expect(violation?.installed).toBeNull();
    expect(violation?.reason).toContain('not installed');
  });

  it('checks expo itself only against the installed version, not a bundled range', () => {
    const passing = checkMobileDeps({ expo: '56.0.12' }, [], { 'expo-haptics': '~56.0.3' }, { expo: '56.0.12' });
    expect(passing.violations).toEqual([]);
    // expo itself never counts as a bundled-map validation.
    expect(passing.checked).toBe(0);

    const drifted = checkMobileDeps({ expo: '56.0.12' }, [], { 'expo-haptics': '~56.0.3' }, { expo: '56.0.13' });
    const violation = violationFor(drifted.violations, 'expo');
    expect(violation).toBeDefined();
    expect(violation?.bundled).toBeNull();
    expect(violation?.reason).toContain('lockfile drift');
  });

  it('can report both a range-alignment and an installed-alignment violation for the same package', () => {
    const { violations } = checkMobileDeps(
      { 'expo-haptics': '55.0.0' },
      [],
      { 'expo-haptics': '~56.0.3' },
      { 'expo-haptics': '54.0.0' },
    );

    const matches = violations.filter((violation) => violation.package === 'expo-haptics');
    expect(matches).toHaveLength(2);
    expect(matches.some((violation) => violation.reason.includes('bundled range'))).toBe(true);
    expect(matches.some((violation) => violation.reason.includes('lockfile drift'))).toBe(true);
  });

  it('reports checked=0 when the bundled map validates nothing (degenerate map)', () => {
    // With an empty map, every declared dep skips rule 1 and no violations
    // surface — `checked` is main()'s only signal that the run proved nothing.
    const { checked, violations } = checkMobileDeps(
      { 'expo-haptics': '56.0.3', 'react-native': '0.85.3' },
      [],
      {},
      { 'expo-haptics': '56.0.3', 'react-native': '0.85.3' },
    );

    expect(checked).toBe(0);
    expect(violations).toEqual([]);
  });

  it('counts each dependency validated against the bundled map', () => {
    const { checked } = checkMobileDeps(
      { 'expo-haptics': '56.0.3', 'react-native': '0.85.3', '@sentry/react-native': '6.22.0' },
      ['@sentry/react-native'],
      { 'expo-haptics': '~56.0.3', 'react-native': '0.85.3', '@sentry/react-native': '~7.11.0' },
      { 'expo-haptics': '56.0.3', 'react-native': '0.85.3', '@sentry/react-native': '6.22.0' },
    );

    expect(checked).toBe(2);
  });
});

describe('readBundledNativeModules', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mdc-bnm-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a well-formed pins map', () => {
    const bundledPath = join(dir, 'bundledNativeModules.json');
    writeFileSync(bundledPath, JSON.stringify({ 'expo-haptics': '~56.0.3' }));

    expect(readBundledNativeModules(bundledPath)).toEqual({ 'expo-haptics': '~56.0.3' });
  });

  it('throws for a missing file (vp install has not run)', () => {
    expect(() => readBundledNativeModules(join(dir, 'does-not-exist.json'))).toThrow(/cannot read/);
  });

  it('throws for malformed JSON', () => {
    const bundledPath = join(dir, 'bundledNativeModules.json');
    writeFileSync(bundledPath, '{ not valid json');

    expect(() => readBundledNativeModules(bundledPath)).toThrow(/cannot parse/);
  });

  it('throws for an empty object — valid JSON that would validate nothing', () => {
    const bundledPath = join(dir, 'bundledNativeModules.json');
    writeFileSync(bundledPath, '{}');

    expect(() => readBundledNativeModules(bundledPath)).toThrow(/empty/);
  });

  it('throws for a JSON array', () => {
    const bundledPath = join(dir, 'bundledNativeModules.json');
    writeFileSync(bundledPath, '["expo-haptics"]');

    expect(() => readBundledNativeModules(bundledPath)).toThrow(/not a JSON object/);
  });

  it('throws when a range value is not a string', () => {
    const bundledPath = join(dir, 'bundledNativeModules.json');
    writeFileSync(bundledPath, JSON.stringify({ 'expo-haptics': 56 }));

    expect(() => readBundledNativeModules(bundledPath)).toThrow(/non-string range for "expo-haptics"/);
  });
});

describe('readExcludeList', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mdc-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the expo.install.exclude array', () => {
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ expo: { install: { exclude: ['a', 'b'] } } }));

    expect(readExcludeList(pkgPath)).toEqual(['a', 'b']);
  });

  it('returns an empty array when expo.install.exclude is absent', () => {
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ name: '@boardsesh/mobile' }));

    expect(readExcludeList(pkgPath)).toEqual([]);
  });

  it('throws a helpful error for a missing file', () => {
    expect(() => readExcludeList(join(dir, 'does-not-exist.json'))).toThrow(/cannot read/);
  });

  it('throws a helpful error for malformed JSON', () => {
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, '{ not valid json');

    expect(() => readExcludeList(pkgPath)).toThrow(/cannot parse/);
  });

  it('throws when expo.install.exclude is a string instead of an array', () => {
    // Without the guard, new Set("react-native") iterates characters and
    // silently excludes nothing — fail loud instead.
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ expo: { install: { exclude: 'react-native' } } }));

    expect(() => readExcludeList(pkgPath)).toThrow(/expo\.install\.exclude .* must be an array/);
  });

  it('throws when expo.install.exclude contains a non-string entry', () => {
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ expo: { install: { exclude: ['react-native', 42] } } }));

    expect(() => readExcludeList(pkgPath)).toThrow(/must contain only strings, got 42/);
  });
});
