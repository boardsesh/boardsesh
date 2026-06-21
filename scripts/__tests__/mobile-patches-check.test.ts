import { describe, expect, it } from 'vitest';
import { checkPatchesApplied, versionFromKey, type PatchCheckEnv, type PatchRule } from '../mobile-patches-check';

const PKG = 'react-native-screens';
const FILE = 'ios/helpers/scroll-view/RNSScrollViewFinder.mm';
const KEY = 'react-native-screens@4.25.2';
const SENTINELS = ['rnscreens_contentScrollViewForEdge', 'findScrollViewDeepFirstFrom'];
const RULES: PatchRule[] = [{ package: PKG, file: FILE, sentinels: SENTINELS, patchedKey: KEY }];

const PATCHED_SOURCE = `
+ (nullable UIScrollView *)findScrollViewDeepFirstFrom:(nullable UIView *)view { /* ... */ }
- (nullable UIScrollView *)rnscreens_contentScrollViewForEdge:(NSDirectionalRectEdge)edge { /* ... */ }
`;

/**
 * Build a fake env from explicit maps so tests never touch a real node_modules
 * tree. A missing key throws, mirroring an unresolvable package / absent file.
 */
function makeEnv(opts: {
  patchedDependencies?: Record<string, string>;
  versions?: Record<string, string>;
  files?: Record<string, string>;
}): PatchCheckEnv {
  return {
    patchedDependencies: opts.patchedDependencies ?? { [KEY]: `patches/${KEY}.patch` },
    readInstalledVersion(pkg) {
      const version = opts.versions?.[pkg];
      if (!version) throw new Error(`Cannot find module '${pkg}/package.json'`);
      return version;
    },
    readInstalledFile(pkg, fileSubpath) {
      const hit = opts.files?.[`${pkg}::${fileSubpath}`];
      if (hit === undefined) throw new Error(`ENOENT: ${pkg}/${fileSubpath}`);
      return hit;
    },
  };
}

describe('checkPatchesApplied', () => {
  it('passes when configured, version matches, and all sentinels are present', () => {
    const env = makeEnv({
      versions: { [PKG]: '4.25.2' },
      files: { [`${PKG}::${FILE}`]: PATCHED_SOURCE },
    });

    const result = checkPatchesApplied(RULES, env);

    expect(result.checked).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('fails when the patch is no longer configured in patchedDependencies', () => {
    const env = makeEnv({
      patchedDependencies: {},
      versions: { [PKG]: '4.25.2' },
      files: { [`${PKG}::${FILE}`]: PATCHED_SOURCE },
    });

    const result = checkPatchesApplied(RULES, env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('patch no longer configured');
  });

  it('fails on version drift — the install would be unpatched', () => {
    const env = makeEnv({
      versions: { [PKG]: '4.25.3' },
      // Even if the file somehow still had the sentinels, drift is reported first.
      files: { [`${PKG}::${FILE}`]: PATCHED_SOURCE },
    });

    const result = checkPatchesApplied(RULES, env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('version drift');
    expect(result.errors[0]).toContain('4.25.3');
    expect(result.errors[0]).toContain('4.25.2');
  });

  it('fails when the version matches but the sentinel is missing (patch silently dropped)', () => {
    const env = makeEnv({
      versions: { [PKG]: '4.25.2' },
      files: { [`${PKG}::${FILE}`]: '// upstream source with no swizzle\n' },
    });

    const result = checkPatchesApplied(RULES, env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('patch NOT applied');
    expect(result.errors[0]).toContain('rnscreens_contentScrollViewForEdge');
    expect(result.errors[0]).toContain('findScrollViewDeepFirstFrom');
  });

  it('fails when only some sentinels are present', () => {
    const env = makeEnv({
      versions: { [PKG]: '4.25.2' },
      files: { [`${PKG}::${FILE}`]: '- (id)rnscreens_contentScrollViewForEdge:(int)e { }\n' },
    });

    const result = checkPatchesApplied(RULES, env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('findScrollViewDeepFirstFrom');
    expect(result.errors[0]).not.toContain('"rnscreens_contentScrollViewForEdge"');
  });

  it('fails when the package is not resolvable from packages/mobile', () => {
    const env = makeEnv({ versions: {}, files: {} });

    const result = checkPatchesApplied(RULES, env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not resolvable from packages/mobile');
  });

  it('fails when the patched file is absent', () => {
    const env = makeEnv({ versions: { [PKG]: '4.25.2' }, files: {} });

    const result = checkPatchesApplied(RULES, env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('cannot read patched file');
  });
});

describe('versionFromKey', () => {
  it('extracts the version from an unscoped key', () => {
    expect(versionFromKey('react-native-screens@4.25.2')).toBe('4.25.2');
  });

  it('extracts the version from a scoped key', () => {
    expect(versionFromKey('@sentry/cli@2.53.0')).toBe('2.53.0');
  });

  it('returns empty string when no version segment is present', () => {
    expect(versionFromKey('react-native-screens')).toBe('');
  });
});
