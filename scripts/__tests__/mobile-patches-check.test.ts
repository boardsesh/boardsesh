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

// The @expo/ui shape: a SCOPED package, so the key carries two `@` and the
// version is the one after the scope. Its patch is plain TS whose loss is
// runtime-only — the sheet still typechecks and bundles, it just stops
// swallowing the native expand()/partialExpand() rejection — so this rule is
// the only thing between a forgotten re-key and a silent regression.
const SCOPED_PKG = '@expo/ui';
const SCOPED_FILE = 'src/community/bottom-sheet/BottomSheet.android.tsx';
const SCOPED_KEY = '@expo/ui@57.0.8';
const SCOPED_PATCH_PATH = 'patches/@expo%2Fui@57.0.8.patch';
const SCOPED_RULES: PatchRule[] = [
  { package: SCOPED_PKG, file: SCOPED_FILE, sentinels: ['swallowMissingNativeHandler'], patchedKey: SCOPED_KEY },
];
const SCOPED_PATCHED_SOURCE = `
function swallowMissingNativeHandler(error: unknown): void { /* ... */ }
sheetRef.current?.expand()?.catch(swallowMissingNativeHandler);
`;
const SCOPED_UPSTREAM_SOURCE = `
sheetRef.current?.expand();
`;

describe('checkPatchesApplied on a scoped package', () => {
  it('passes when the scoped key matches and the sentinel is present', () => {
    const env = makeEnv({
      patchedDependencies: { [SCOPED_KEY]: SCOPED_PATCH_PATH },
      versions: { [SCOPED_PKG]: '57.0.8' },
      files: { [`${SCOPED_PKG}::${SCOPED_FILE}`]: SCOPED_PATCHED_SOURCE },
    });

    const result = checkPatchesApplied(SCOPED_RULES, env);

    expect(result.checked).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('fails on version drift — the scope must not swallow the version segment', () => {
    const env = makeEnv({
      patchedDependencies: { [SCOPED_KEY]: SCOPED_PATCH_PATH },
      versions: { [SCOPED_PKG]: '57.0.9' },
      files: { [`${SCOPED_PKG}::${SCOPED_FILE}`]: SCOPED_PATCHED_SOURCE },
    });

    const result = checkPatchesApplied(SCOPED_RULES, env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('version drift');
    expect(result.errors[0]).toContain('57.0.9');
    expect(result.errors[0]).toContain('57.0.8');
  });

  it('fails when the key still matches but the sentinel is gone (patch silently dropped)', () => {
    const env = makeEnv({
      patchedDependencies: { [SCOPED_KEY]: SCOPED_PATCH_PATH },
      versions: { [SCOPED_PKG]: '57.0.8' },
      files: { [`${SCOPED_PKG}::${SCOPED_FILE}`]: SCOPED_UPSTREAM_SOURCE },
    });

    const result = checkPatchesApplied(SCOPED_RULES, env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('patch NOT applied');
    expect(result.errors[0]).toContain('swallowMissingNativeHandler');
  });
});

describe('checkPatchesApplied across several packages', () => {
  it('checks every rule and reports each package independently', () => {
    const env = makeEnv({
      patchedDependencies: { [KEY]: `patches/${KEY}.patch`, [SCOPED_KEY]: SCOPED_PATCH_PATH },
      versions: { [PKG]: '4.25.2', [SCOPED_PKG]: '57.0.8' },
      files: {
        [`${PKG}::${FILE}`]: PATCHED_SOURCE,
        // Only the scoped package lost its patch.
        [`${SCOPED_PKG}::${SCOPED_FILE}`]: SCOPED_UPSTREAM_SOURCE,
      },
    });

    const result = checkPatchesApplied([...RULES, ...SCOPED_RULES], env);

    expect(result.checked).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(SCOPED_PKG);
    expect(result.errors[0]).not.toContain(PKG);
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
