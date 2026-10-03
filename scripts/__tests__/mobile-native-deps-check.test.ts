import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkNativeBuildPhaseDeps,
  readMobileDeps,
  nodeResolver,
  RULES as NATIVE_DEP_RULES,
  type DepResolver,
  type NativeDepRule,
} from '../mobile-native-deps-check';

const MOBILE_PKG = '/repo/packages/mobile/package.json';
const RN = '@sentry/react-native';
const CLI = '@sentry/cli';
const RULES: NativeDepRule[] = [{ trigger: RN, tools: [CLI] }];

/**
 * Build a fake resolver from explicit maps so tests never touch a real
 * node_modules tree. `resolveMap` is keyed `"<from>::<request>"`; `versionMap`
 * is keyed by resolved path. A missing key throws, mirroring Node.
 */
function makeResolver(resolveMap: Record<string, string>, versionMap: Record<string, string> = {}): DepResolver {
  return {
    resolve(from, request) {
      const hit = resolveMap[`${from}::${request}`];
      if (!hit) throw new Error(`Cannot find module '${request}' from '${from}'`);
      return hit;
    },
    readVersion(path) {
      const version = versionMap[path];
      if (!version) throw new Error(`no "version" field in ${path}`);
      return version;
    },
  };
}

describe('checkNativeBuildPhaseDeps', () => {
  it('checks the actual installed SDK and native CLI dependencies', () => {
    const mobilePackageJson = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'packages/mobile/package.json',
    );
    expect(
      checkNativeBuildPhaseDeps(mobilePackageJson, readMobileDeps(mobilePackageJson), NATIVE_DEP_RULES, nodeResolver),
    ).toEqual({ checked: 1, errors: [] });
  });

  it('checks Sentry 8.24 CLI from the SDK even when the standalone CLI differs', () => {
    const resolver = makeResolver(
      {
        [`${MOBILE_PKG}::${RN}/package.json`]: '/store/rn/package.json',
        [`${MOBILE_PKG}::${CLI}/package.json`]: '/store/cli-2.58.4/package.json',
        [`/store/rn/package.json::${CLI}/package.json`]: '/store/cli-3.6.2/package.json',
      },
      {
        '/store/rn/package.json': '8.24.0',
        '/store/cli-2.58.4/package.json': '2.58.4',
        '/store/cli-3.6.2/package.json': '3.6.2',
      },
    );
    expect(
      checkNativeBuildPhaseDeps(MOBILE_PKG, { [RN]: '8.24.0', [CLI]: '2.58.4' }, NATIVE_DEP_RULES, resolver),
    ).toEqual({
      checked: 1,
      errors: [],
    });
  });

  it('rejects Sentry 8.24 when its SDK-owned CLI is missing even if mobile resolves a CLI', () => {
    const resolver = makeResolver(
      {
        [`${MOBILE_PKG}::${RN}/package.json`]: '/store/rn/package.json',
        [`${MOBILE_PKG}::${CLI}/package.json`]: '/store/cli-2.58.4/package.json',
      },
      { '/store/rn/package.json': '8.24.0', '/store/cli-2.58.4/package.json': '2.58.4' },
    );
    const result = checkNativeBuildPhaseDeps(MOBILE_PKG, { [RN]: '8.24.0' }, NATIVE_DEP_RULES, resolver);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`could not verify ${CLI} resolution from ${RN}`);
  });

  it.each(['7.11.0', '8.25.0'])('keeps mobile CLI alignment for other installed SDKs, including %s', (version) => {
    const resolver = makeResolver(
      {
        [`${MOBILE_PKG}::${RN}/package.json`]: '/store/rn/package.json',
        [`${MOBILE_PKG}::${CLI}/package.json`]: '/store/cli-2.58.4/package.json',
        [`/store/rn/package.json::${CLI}/package.json`]: '/store/cli-3.6.2/package.json',
      },
      {
        '/store/rn/package.json': version,
        '/store/cli-2.58.4/package.json': '2.58.4',
        '/store/cli-3.6.2/package.json': '3.6.2',
      },
    );
    // Manifest text is insufficient: an unaudited installed version must not
    // inherit the exception just because the declared pin says 8.24.
    const result = checkNativeBuildPhaseDeps(MOBILE_PKG, { [RN]: '8.24.0' }, NATIVE_DEP_RULES, resolver);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('version drift');
  });

  it('passes when the tool resolves and versions are aligned', () => {
    const resolver = makeResolver(
      {
        [`${MOBILE_PKG}::${CLI}/package.json`]: '/store/cli-2.53.0/package.json',
        [`${MOBILE_PKG}::${RN}/package.json`]: '/store/rn/package.json',
        [`/store/rn/package.json::${CLI}/package.json`]: '/store/cli-2.53.0/package.json',
      },
      { '/store/cli-2.53.0/package.json': '2.53.0' },
    );

    const result = checkNativeBuildPhaseDeps(MOBILE_PKG, { [RN]: '^6.14.0', [CLI]: '2.53.0' }, RULES, resolver);

    expect(result.checked).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('skips rules whose trigger is not a mobile dependency', () => {
    const resolver = makeResolver({});
    const result = checkNativeBuildPhaseDeps(MOBILE_PKG, { expo: '~56.0.0' }, RULES, resolver);

    expect(result.checked).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('fails when the tool is not resolvable from packages/mobile', () => {
    // The exact regression that broke the TestFlight archive: @sentry/cli is a
    // transitive-only dep, so resolving it from packages/mobile throws.
    const resolver = makeResolver({
      [`${MOBILE_PKG}::${RN}/package.json`]: '/store/rn/package.json',
    });

    const result = checkNativeBuildPhaseDeps(MOBILE_PKG, { [RN]: '^6.14.0' }, RULES, resolver);

    expect(result.checked).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not resolvable from packages/mobile');
    expect(result.errors[0]).toContain(CLI);
  });

  it('fails on version drift between the direct pin and the trigger requirement', () => {
    const resolver = makeResolver(
      {
        [`${MOBILE_PKG}::${CLI}/package.json`]: '/store/cli-2.53.0/package.json',
        [`${MOBILE_PKG}::${RN}/package.json`]: '/store/rn/package.json',
        [`/store/rn/package.json::${CLI}/package.json`]: '/store/cli-2.55.0/package.json',
      },
      { '/store/cli-2.53.0/package.json': '2.53.0', '/store/cli-2.55.0/package.json': '2.55.0' },
    );

    const result = checkNativeBuildPhaseDeps(MOBILE_PKG, { [RN]: '^6.14.0', [CLI]: '2.53.0' }, RULES, resolver);

    expect(result.checked).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('version drift');
    expect(result.errors[0]).toContain('2.53.0');
    expect(result.errors[0]).toContain('2.55.0');
  });

  it('reports an alignment-verification error when the trigger cannot resolve the tool', () => {
    // Tool resolves from mobile (1) but resolving it from the trigger (2) fails.
    const resolver = makeResolver(
      {
        [`${MOBILE_PKG}::${CLI}/package.json`]: '/store/cli-2.53.0/package.json',
        [`${MOBILE_PKG}::${RN}/package.json`]: '/store/rn/package.json',
        // intentionally omit `/store/rn/package.json::@sentry/cli/package.json`
      },
      { '/store/cli-2.53.0/package.json': '2.53.0' },
    );

    const result = checkNativeBuildPhaseDeps(MOBILE_PKG, { [RN]: '^6.14.0', [CLI]: '2.53.0' }, RULES, resolver);

    expect(result.checked).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('could not verify');
  });

  it('checks every tool in a multi-tool rule', () => {
    const multiRule: NativeDepRule[] = [{ trigger: RN, tools: [CLI, '@sentry/other-cli'] }];
    const resolver = makeResolver({
      [`${MOBILE_PKG}::${RN}/package.json`]: '/store/rn/package.json',
      // neither tool resolves from mobile
    });

    const result = checkNativeBuildPhaseDeps(MOBILE_PKG, { [RN]: '^6.14.0' }, multiRule, resolver);

    expect(result.checked).toBe(2);
    expect(result.errors).toHaveLength(2);
  });
});

describe('readMobileDeps', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mnd-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges dependencies and devDependencies (dependencies win)', () => {
    const pkgPath = join(dir, 'package.json');
    writeFileSync(
      pkgPath,
      JSON.stringify({
        dependencies: { '@sentry/cli': '2.53.0', expo: '~56.0.0' },
        devDependencies: { tsx: '^4.0.0', expo: '~55.0.0' },
      }),
    );

    const deps = readMobileDeps(pkgPath);

    expect(deps).toEqual({ '@sentry/cli': '2.53.0', expo: '~56.0.0', tsx: '^4.0.0' });
  });

  it('returns an empty map when neither dependency block is present', () => {
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ name: '@boardsesh/mobile' }));

    expect(readMobileDeps(pkgPath)).toEqual({});
  });

  it('throws a helpful error for a missing file', () => {
    expect(() => readMobileDeps(join(dir, 'does-not-exist.json'))).toThrow(/cannot read/);
  });

  it('throws a helpful error for malformed JSON', () => {
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, '{ not valid json');

    expect(() => readMobileDeps(pkgPath)).toThrow(/cannot parse/);
  });
});
