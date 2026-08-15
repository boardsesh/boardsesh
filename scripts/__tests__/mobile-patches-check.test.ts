import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RULES as REAL_RULES,
  UNGUARDED_PATCHES,
  checkPatchInventory,
  checkPatchesApplied,
  extractObjCMethodBody,
  versionFromKey,
  type PatchCheckEnv,
  type PatchRule,
} from '../mobile-patches-check';

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
// swallowing the native expand()/partialExpand()/hide() rejection — so this
// rule is the only thing between a forgotten re-key and a silent regression.
const SCOPED_PKG = '@expo/ui';
const SCOPED_FILE = 'src/community/bottom-sheet/BottomSheet.android.tsx';
const SCOPED_KEY = '@expo/ui@57.0.11';
const SCOPED_PATCH_PATH = 'patches/@expo%2Fui@57.0.11.patch';
const SCOPED_RULES: PatchRule[] = [
  { package: SCOPED_PKG, file: SCOPED_FILE, sentinels: ['swallowMissingNativeHandler'], patchedKey: SCOPED_KEY },
];

type ExpoImageUrlShape = {
  scheme: string | null;
  host: string | null;
  relativePath: string;
};

// Portable model of the Foundation URL properties consumed by the Swift
// patch. These cases mirror Expo's relative xcasset URL representation and the
// absolute/hosted filesystem URLs that must bypass UIImage(named:).
function modelPatchedLocalAssetName({ scheme, host, relativePath }: ExpoImageUrlShape): string | null {
  if (scheme !== null && scheme !== 'file') return null;

  const hasFileHost = scheme === 'file' && host !== null && host.length > 0;
  const hasAbsoluteFilePath = scheme === 'file' && relativePath.startsWith('/');
  if (hasFileHost || hasAbsoluteFilePath) return null;

  const assetName = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return assetName.length > 0 ? assetName : null;
}

function expoImageGuardRunsBeforeSlashStripping(source: string): boolean {
  const functionIndex = source.indexOf('func localAssetName(from url: URL?)');
  const hostGuardIndex = source.indexOf('let hasFileHost', functionIndex);
  const absolutePathGuardIndex = source.indexOf('let hasAbsoluteFilePath', functionIndex);
  const combinedGuardIndex = source.indexOf('if hasFileHost || hasAbsoluteFilePath', functionIndex);
  const stripLeadingSlashIndex = source.indexOf('if path.hasPrefix("/")', functionIndex);

  return (
    functionIndex >= 0 &&
    hostGuardIndex > functionIndex &&
    absolutePathGuardIndex > hostGuardIndex &&
    combinedGuardIndex > absolutePathGuardIndex &&
    stripLeadingSlashIndex > combinedGuardIndex
  );
}
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
      versions: { [SCOPED_PKG]: '57.0.11' },
      files: { [`${SCOPED_PKG}::${SCOPED_FILE}`]: SCOPED_PATCHED_SOURCE },
    });

    const result = checkPatchesApplied(SCOPED_RULES, env);

    expect(result.checked).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('fails on version drift — the scope must not swallow the version segment', () => {
    const env = makeEnv({
      patchedDependencies: { [SCOPED_KEY]: SCOPED_PATCH_PATH },
      versions: { [SCOPED_PKG]: '57.0.12' },
      files: { [`${SCOPED_PKG}::${SCOPED_FILE}`]: SCOPED_PATCHED_SOURCE },
    });

    const result = checkPatchesApplied(SCOPED_RULES, env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('version drift');
    expect(result.errors[0]).toContain('57.0.12');
    expect(result.errors[0]).toContain('57.0.11');
  });

  it('fails when the key still matches but the sentinel is gone (patch silently dropped)', () => {
    const env = makeEnv({
      patchedDependencies: { [SCOPED_KEY]: SCOPED_PATCH_PATH },
      versions: { [SCOPED_PKG]: '57.0.11' },
      files: { [`${SCOPED_PKG}::${SCOPED_FILE}`]: SCOPED_UPSTREAM_SOURCE },
    });

    const result = checkPatchesApplied(SCOPED_RULES, env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('patch NOT applied');
    expect(result.errors[0]).toContain('swallowMissingNativeHandler');
  });
});

// Mutation tests on the shipped rule, not a synthetic one: the sentinel list
// must distinguish the current patch from the pre-#4108 patch, the
// short-circuiting hide helper, and a helper that normalizes a missing ref but
// drops only the hide rejection guard. The expand catches remain in every
// relevant fixture so none can masquerade as proof that hide itself is guarded.
describe('the shipped @expo/ui Android rule', () => {
  const androidRule = REAL_RULES.find((rule) => rule.package === SCOPED_PKG && rule.file === SCOPED_FILE);

  const PRE_4108_SOURCE = `
function swallowMissingNativeHandler(error: unknown): void { /* ... */ }
sheetRef.current?.expand()?.catch(swallowMissingNativeHandler);
sheetRef.current?.partialExpand()?.catch(swallowMissingNativeHandler);
sheetRef.current?.hide().then(() => { setIsOpen(false); fireCloseCallbacks(); });
`;

  const SHORT_CIRCUITING_HIDE_SOURCE = `
function swallowMissingNativeHandler(error: unknown): void { /* ... */ }
sheetRef.current?.expand()?.catch(swallowMissingNativeHandler);
sheetRef.current?.partialExpand()?.catch(swallowMissingNativeHandler);
const hideSwallowingMissingNativeHandler = () => {
  void sheetRef.current?.hide().catch(swallowMissingNativeHandler).then(runCleanup);
};
hideSwallowingMissingNativeHandler();
const close = hideSwallowingMissingNativeHandler;
`;

  const HIDE_WITHOUT_CATCH_SOURCE = `
function swallowMissingNativeHandler(error: unknown): void { /* ... */ }
sheetRef.current?.expand()?.catch(swallowMissingNativeHandler);
sheetRef.current?.partialExpand()?.catch(swallowMissingNativeHandler);
const hideSwallowingMissingNativeHandler = () => {
  const hidePromise = sheetRef.current?.hide();
  void Promise.resolve(hidePromise).then(runCleanup);
};
hideSwallowingMissingNativeHandler();
const close = hideSwallowingMissingNativeHandler;
`;

  it('is registered', () => {
    expect(androidRule).toBeDefined();
  });

  it('goes red on the pre-#4108 patch that guarded only expand()/partialExpand()', () => {
    if (!androidRule) throw new Error('no @expo/ui Android rule registered');
    const env = makeEnv({
      patchedDependencies: { [androidRule.patchedKey]: SCOPED_PATCH_PATH },
      versions: { [androidRule.package]: versionFromKey(androidRule.patchedKey) },
      files: { [`${androidRule.package}::${androidRule.file}`]: PRE_4108_SOURCE },
    });

    const result = checkPatchesApplied([androidRule], env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('patch NOT applied');
    expect(result.errors[0]).toContain('hideSwallowingMissingNativeHandler');
  });

  it('goes red when a missing sheet ref can short-circuit the JS cleanup', () => {
    if (!androidRule) throw new Error('no @expo/ui Android rule registered');
    const env = makeEnv({
      patchedDependencies: { [androidRule.patchedKey]: SCOPED_PATCH_PATH },
      versions: { [androidRule.package]: versionFromKey(androidRule.patchedKey) },
      files: { [`${androidRule.package}::${androidRule.file}`]: SHORT_CIRCUITING_HIDE_SOURCE },
    });

    const result = checkPatchesApplied([androidRule], env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('patch NOT applied');
    expect(result.errors[0]).toContain('Promise.resolve(hidePromise)');
  });

  it('goes red when only the hide rejection catch is removed', () => {
    if (!androidRule) throw new Error('no @expo/ui Android rule registered');
    const env = makeEnv({
      patchedDependencies: { [androidRule.patchedKey]: SCOPED_PATCH_PATH },
      versions: { [androidRule.package]: versionFromKey(androidRule.patchedKey) },
      files: { [`${androidRule.package}::${androidRule.file}`]: HIDE_WITHOUT_CATCH_SOURCE },
    });

    const result = checkPatchesApplied([androidRule], env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('patch NOT applied');
    expect(result.errors[0]).toContain('.catch(swallowMissingNativeHandler)');
    expect(result.errors[0]).not.toContain('hideSwallowingMissingNativeHandler();');
    expect(result.errors[0]).not.toContain('const close = hideSwallowingMissingNativeHandler;');
  });
});

describe('the shipped @expo/ui iOS rule', () => {
  const iosFile = 'src/community/bottom-sheet/BottomSheet.ios.tsx';
  const iosRule = REAL_RULES.find((rule) => rule.package === SCOPED_PKG && rule.file === iosFile);
  const onChangeClosedCall = 'onChangeRef.current?.(-1);';
  const onFullyDismissedCall = 'onFullyDismissedRef.current?.();';
  const installedSource = readFileSync(
    resolve(import.meta.dirname, '../../packages/mobile/node_modules/@expo/ui', iosFile),
    'utf8',
  );

  function checkInstalledSource(source: string) {
    if (!iosRule) throw new Error('no @expo/ui iOS rule registered');
    return checkPatchesApplied(
      [iosRule],
      makeEnv({
        patchedDependencies: { [iosRule.patchedKey]: SCOPED_PATCH_PATH },
        versions: { [iosRule.package]: versionFromKey(iosRule.patchedKey) },
        files: { [`${iosRule.package}::${iosRule.file}`]: source },
      }),
    );
  }

  it('pins index -1 before the fully-dismissed signal in the shipped rule', () => {
    expect(iosRule?.orderedSentinels).toEqual([onChangeClosedCall, onFullyDismissedCall]);
    expect(checkInstalledSource(installedSource).errors).toEqual([]);
  });

  it('goes red if the fully-dismissed signal moves before index -1', () => {
    const reversedSource = installedSource
      .replace(onChangeClosedCall, '__BOARDSESH_ON_CHANGE_CLOSED__')
      .replace(onFullyDismissedCall, onChangeClosedCall)
      .replace('__BOARDSESH_ON_CHANGE_CLOSED__', onFullyDismissedCall);

    expect(reversedSource).not.toBe(installedSource);
    expect(checkInstalledSource(reversedSource).errors).toEqual([
      expect.stringContaining(`"${onChangeClosedCall}" must appear before "${onFullyDismissedCall}"`),
    ]);
  });
});

describe('the shipped expo-image local-asset guard', () => {
  const imageViewSource = readFileSync(
    resolve(import.meta.dirname, '../../packages/mobile/node_modules/expo-image/ios/ImageView.swift'),
    'utf8',
  );

  it('rejects filesystem URLs before stripping the leading slash', () => {
    expect(expoImageGuardRunsBeforeSlashStripping(imageViewSource)).toBe(true);
    expect(imageViewSource).not.toContain('url.baseURL == nil');
    expect(imageViewSource).not.toContain('path.contains("/")');
  });

  it('goes red if the leading-slash normalization moves ahead of the filesystem guard', () => {
    const guardBlock = `  let hasFileHost = url.scheme == "file" && !(url.host?.isEmpty ?? true)
  let hasAbsoluteFilePath = url.scheme == "file" && path.hasPrefix("/")
  if hasFileHost || hasAbsoluteFilePath {
    return nil
  }
`;
    const slashNormalizationBlock = `  if path.hasPrefix("/") {
    path.removeFirst()
  }
`;
    const reorderedSource = imageViewSource.replace(
      `${guardBlock}${slashNormalizationBlock}`,
      `${slashNormalizationBlock}${guardBlock}`,
    );

    expect(reorderedSource).not.toBe(imageViewSource);
    expect(expoImageGuardRunsBeforeSlashStripping(reorderedSource)).toBe(false);
  });

  it.each([
    {
      name: 'keeps relative URL(fileURLWithPath:) asset names',
      url: { scheme: 'file', host: null, relativePath: 'app_icon' },
      expected: 'app_icon',
    },
    {
      name: 'keeps nested xcasset URL(fileURLWithPath:) names',
      url: { scheme: 'file', host: null, relativePath: 'Images/MyIcon' },
      expected: 'Images/MyIcon',
    },
    {
      name: 'keeps a scheme-less /app_icon name',
      url: { scheme: null, host: null, relativePath: '/app_icon' },
      expected: 'app_icon',
    },
    {
      name: 'rejects file:///private paths',
      url: { scheme: 'file', host: '', relativePath: '/private/var/mobile/board.png' },
      expected: null,
    },
    {
      name: 'rejects root-level file:///app_icon URLs',
      url: { scheme: 'file', host: '', relativePath: '/app_icon' },
      expected: null,
    },
    {
      name: 'rejects absolute URL(fileURLWithPath:) values',
      url: { scheme: 'file', host: null, relativePath: '/app_icon' },
      expected: null,
    },
    {
      name: 'rejects file://host paths',
      url: { scheme: 'file', host: 'board-cache', relativePath: '/board.png' },
      expected: null,
    },
    {
      name: 'rejects non-file schemes',
      url: { scheme: 'https', host: 'example.com', relativePath: '/app_icon' },
      expected: null,
    },
    {
      name: 'rejects an empty asset name',
      url: { scheme: null, host: null, relativePath: '' },
      expected: null,
    },
  ] satisfies readonly { name: string; url: ExpoImageUrlShape; expected: string | null }[])(
    '$name',
    ({ url, expected }) => {
      expect(modelPatchedLocalAssetName(url)).toBe(expected);
    },
  );
});

describe('checkPatchesApplied across several packages', () => {
  it('checks every rule and reports each package independently', () => {
    const env = makeEnv({
      patchedDependencies: { [KEY]: `patches/${KEY}.patch`, [SCOPED_KEY]: SCOPED_PATCH_PATH },
      versions: { [PKG]: '4.25.2', [SCOPED_PKG]: '57.0.11' },
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

// ---------------------------------------------------------------------------
// The RNSTabsHostComponentView guard (BOARDSESH-9K).
//
// The crashing version of this patch and the fixed one BOTH define
// `rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance`. What separates
// them is where the layout happens, so the guard has to assert the deferral
// machinery and the absence of a synchronous layout in the mounting-transaction
// path — not just the presence of a symbol.
// ---------------------------------------------------------------------------

const TABS_FILE = 'ios/tabs/host/RNSTabsHostComponentView.mm';
const TABS_KEY = 'react-native-screens@4.26.2';
const TABS_RULES: PatchRule[] = [
  {
    package: PKG,
    file: TABS_FILE,
    sentinels: [
      'rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance',
      'rnscreens_layoutBottomAccessoryOutsideTransition',
      '_rnscreens_bottomAccessoryRelayoutScheduled',
      'animateAlongsideTransition',
    ],
    patchedKey: TABS_KEY,
    forbiddenInMethod: [
      {
        method: 'applyBottomAccessoryVisibility',
        substrings: ['layoutIfNeeded', 'layoutBelowIfNeeded'],
        why: 'synchronous layout inside the RN mounting transaction — BOARDSESH-9K',
      },
    ],
  },
];

/** The shipped (2.3.1) shape: attach-only nudge, layout deferred off-transaction. */
const TABS_FIXED_SOURCE = `
- (void)applyBottomAccessoryVisibility API_AVAILABLE(ios(26.0))
{
  if (_bottomAccessoryWrapperView != nil) {
    [_controller setBottomAccessory:accessory animated:YES];
    [self rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance];
  }
}

// The original version of this method called -layoutIfNeeded right there, and
// that synchronous layout got pulled into a UIKit feedback loop.
- (void)rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance
{
  if (_rnscreens_bottomAccessoryRelayoutScheduled) {
    return;
  }
  _rnscreens_bottomAccessoryRelayoutScheduled = YES;
  dispatch_async(dispatch_get_main_queue(), ^{
    [weakSelf rnscreens_layoutBottomAccessoryOutsideTransition];
  });
}

- (void)rnscreens_layoutBottomAccessoryOutsideTransition
{
  if (transitionCoordinator != nil) {
    BOOL registered = [transitionCoordinator animateAlongsideTransition:nil completion:^(id context) {
      [weakSelf rnscreens_layoutBottomAccessoryOutsideTransition];
    }];
    if (registered) {
      return;
    }
  }
  _rnscreens_bottomAccessoryRelayoutScheduled = NO;
  [controllerView setNeedsLayout];
  [controllerView layoutIfNeeded];
}
`;

/** A re-keyed patch that kept the symbols but restored the crashing layout. */
const TABS_REGRESSED_SOURCE = TABS_FIXED_SOURCE.replace(
  '[self rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance];',
  '[self rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance];\n    [_controller.view layoutIfNeeded];',
);

const tabsEnv = (source: string) =>
  makeEnv({
    patchedDependencies: { [TABS_KEY]: `patches/${TABS_KEY}.patch` },
    versions: { [PKG]: '4.26.2' },
    files: { [`${PKG}::${TABS_FILE}`]: source },
  });

describe('extractObjCMethodBody', () => {
  it('extracts a body and stops at the closing brace, not the next declaration', () => {
    const body = extractObjCMethodBody(TABS_FIXED_SOURCE, 'applyBottomAccessoryVisibility');

    expect(body).toContain('rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance');
    expect(body).not.toContain('dispatch_async');
    expect(body).not.toContain('layoutIfNeeded');
  });

  it('returns null when the method is absent', () => {
    expect(extractObjCMethodBody(TABS_FIXED_SOURCE, 'someUpstreamRenamedMethod')).toBeNull();
  });

  it('ignores prose in comments — the patch documents the crashing call by name', () => {
    const source = `
- (void)applyBottomAccessoryVisibility
{
  // The old version called -layoutIfNeeded here. Never do that again.
  /* layoutIfNeeded */
  [self nudge];
}
`;

    expect(extractObjCMethodBody(source, 'applyBottomAccessoryVisibility')).not.toContain('layoutIfNeeded');
  });

  // RNSTabsHostComponentView.mm already carries two `@interface (…)` class
  // extensions. If upstream ever forward-declares the anchor in one of them, a
  // first-match slicer would read the @implementation ivar block instead of the
  // method body, and the negative assertion would silently pass on crashing code.
  it('skips a forward declaration and finds the real definition', () => {
    const source = `
@interface RNSTabsHostComponentView ()
- (void)applyBottomAccessoryVisibility API_AVAILABLE(ios(26.0));
@end

@implementation RNSTabsHostComponentView {
  BOOL _rnscreens_bottomAccessoryRelayoutScheduled;
}

- (void)applyBottomAccessoryVisibility API_AVAILABLE(ios(26.0))
{
  [_controller.view layoutIfNeeded];
}
@end
`;

    expect(extractObjCMethodBody(source, 'applyBottomAccessoryVisibility')).toContain('layoutIfNeeded');
  });

  it('returns null when only a forward declaration exists, so the check fails loudly', () => {
    const source = `
@interface RNSTabsHostComponentView ()
- (void)applyBottomAccessoryVisibility;
@end
`;

    expect(extractObjCMethodBody(source, 'applyBottomAccessoryVisibility')).toBeNull();
  });

  it('handles class methods and nested braces', () => {
    const source = `
+ (void)load
{
  if (yes) {
    [self doThing];
  }
}
- (void)next
{
  [self other];
}
`;
    const body = extractObjCMethodBody(source, 'load');

    expect(body).toContain('doThing');
    expect(body).not.toContain('other');
  });
});

describe('checkPatchesApplied forbiddenInMethod', () => {
  it('passes on the shipped shape — layoutIfNeeded lives only in the deferred helper', () => {
    const result = checkPatchesApplied(TABS_RULES, tabsEnv(TABS_FIXED_SOURCE));

    expect(result.errors).toEqual([]);
  });

  it('fails when a synchronous layout is back inside applyBottomAccessoryVisibility', () => {
    const result = checkPatchesApplied(TABS_RULES, tabsEnv(TABS_REGRESSED_SOURCE));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('applyBottomAccessoryVisibility');
    expect(result.errors[0]).toContain('layoutIfNeeded');
    expect(result.errors[0]).toContain('BOARDSESH-9K');
  });

  it('fails loudly when the anchor method cannot be found (upstream moved it)', () => {
    const renamed = TABS_FIXED_SOURCE.replaceAll('applyBottomAccessoryVisibility', 'updateBottomAccessoryVisibility');

    const result = checkPatchesApplied(TABS_RULES, tabsEnv(renamed));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('cannot locate');
    expect(result.errors[0]).toContain('re-verify');
  });

  it.each([
    'rnscreens_layoutBottomAccessoryOutsideTransition',
    '_rnscreens_bottomAccessoryRelayoutScheduled',
    'animateAlongsideTransition',
  ])('reports a missing deferral sentinel: %s', (sentinel) => {
    const withoutSentinel = TABS_FIXED_SOURCE.replaceAll(sentinel, 'someOtherThing');

    const result = checkPatchesApplied(TABS_RULES, tabsEnv(withoutSentinel));

    expect(result.errors.join('\n')).toContain(sentinel);
  });
});

describe('checkPatchInventory', () => {
  const base = {
    patchedDependencies: { [TABS_KEY]: `patches/${TABS_KEY}.patch` },
    patchFilenames: [`${TABS_KEY}.patch`],
    guardedKeys: [TABS_KEY],
    allowUnguarded: {},
  };

  it('passes when every key has a file, a file has a key, and every key is guarded', () => {
    expect(checkPatchInventory(base)).toEqual([]);
  });

  it('fails when a key points at a patch file that is not there', () => {
    const errors = checkPatchInventory({ ...base, patchFilenames: [] });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not in patches/');
  });

  it('fails on an orphaned patch file left behind by a re-key', () => {
    const errors = checkPatchInventory({
      ...base,
      patchFilenames: [`${TABS_KEY}.patch`, 'react-native-screens@4.25.2.patch'],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('orphaned');
    expect(errors[0]).toContain('4.25.2');
  });

  it('fails when a newly patched package has no rule and no allowlist entry', () => {
    const errors = checkPatchInventory({
      ...base,
      patchedDependencies: {
        ...base.patchedDependencies,
        'some-native-mod@1.0.0': 'patches/some-native-mod@1.0.0.patch',
      },
      patchFilenames: [...base.patchFilenames, 'some-native-mod@1.0.0.patch'],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('patched but unguarded');
  });

  it('passes an unguarded package once it is allowlisted with a reason', () => {
    const errors = checkPatchInventory({
      ...base,
      patchedDependencies: {
        ...base.patchedDependencies,
        'some-native-mod@1.0.0': 'patches/some-native-mod@1.0.0.patch',
      },
      patchFilenames: [...base.patchFilenames, 'some-native-mod@1.0.0.patch'],
      allowUnguarded: { 'some-native-mod@1.0.0': 'unreachable from packages/mobile' },
    });

    expect(errors).toEqual([]);
  });

  it('resolves the URL-encoded scoped patch filename against the directory listing', () => {
    const errors = checkPatchInventory({
      patchedDependencies: { '@expo/ui@57.0.11': 'patches/@expo%2Fui@57.0.11.patch' },
      patchFilenames: ['@expo%2Fui@57.0.11.patch'],
      guardedKeys: ['@expo/ui@57.0.11'],
      allowUnguarded: {},
    });

    expect(errors).toEqual([]);
  });
});

// This is the assertion that fires if a future react-native-screens bump
// quietly narrows the guard back to the single symbol it started with.
describe('the shipped RULES', () => {
  const tabsHostRule = REAL_RULES.find(
    (rule) => rule.package === 'react-native-screens' && rule.file === 'ios/tabs/host/RNSTabsHostComponentView.mm',
  );

  it('still guards the tabs host', () => {
    expect(tabsHostRule).toBeDefined();
  });

  it('asserts the deferral machinery, not just the entry-point symbol', () => {
    expect(tabsHostRule?.sentinels).toEqual(
      expect.arrayContaining([
        'rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance',
        'rnscreens_layoutBottomAccessoryOutsideTransition',
        '_rnscreens_bottomAccessoryRelayoutScheduled',
        'animateAlongsideTransition',
      ]),
    );
  });

  it('forbids a synchronous layout inside applyBottomAccessoryVisibility', () => {
    const forbidden = tabsHostRule?.forbiddenInMethod?.find(
      (entry) => entry.method === 'applyBottomAccessoryVisibility',
    );

    expect(forbidden?.substrings).toEqual(expect.arrayContaining(['layoutIfNeeded']));
    expect(forbidden?.why).toContain('BOARDSESH-9K');
  });

  it('keeps a written reason for every deliberately unguarded patch', () => {
    for (const [key, reason] of Object.entries(UNGUARDED_PATCHES)) {
      expect(reason.length, `${key} needs a reason`).toBeGreaterThan(20);
    }
  });

  // Guards against the #3928 fix silently dropping on the next expo-image
  // bump: `patchedDependencies` is keyed by an EXACT version, so a bump that
  // forgets to re-key the patch installs expo-image UNPATCHED and this rule
  // would keep asserting against a key nothing resolves to. Pinning it to
  // packages/mobile/package.json's declared version turns that drift into a
  // failing test instead of a silent no-op.
  it('keeps the expo-image local-asset patch keyed to the pinned mobile version', () => {
    const expoImageRule = REAL_RULES.find((rule) => rule.package === 'expo-image');
    expect(expoImageRule).toBeDefined();

    const mobilePackageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../packages/mobile/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const pinnedVersion = mobilePackageJson.dependencies?.['expo-image'];

    expect(pinnedVersion, 'expo-image must stay a direct packages/mobile dependency').toBeDefined();
    expect(versionFromKey(expoImageRule?.patchedKey ?? '')).toBe(pinnedVersion);
    expect(expoImageRule?.sentinels).toEqual(
      expect.arrayContaining([
        'boardsesh/boardsesh#3928',
        'let hasFileHost = url.scheme == "file" && !(url.host?.isEmpty ?? true)',
        'let hasAbsoluteFilePath = url.scheme == "file" && path.hasPrefix("/")',
        'if hasFileHost || hasAbsoluteFilePath',
        'Images/MyIcon',
      ]),
    );
  });

  it('rejects the old post-normalization guard that leaks root-level file URLs', () => {
    const expoImageRule = REAL_RULES.find((rule) => rule.package === 'expo-image');
    if (!expoImageRule) throw new Error('no expo-image rule registered');

    const postNormalizationGuardSource = `
// boardsesh/boardsesh#3928
// Namespaced asset name: Images/MyIcon
if url.scheme == "file" {
  if let host = url.host, !host.isEmpty { return nil }
  if url.baseURL == nil && path.contains("/") { return nil }
}
`;
    const env = makeEnv({
      patchedDependencies: { [expoImageRule.patchedKey]: 'patches/expo-image@57.0.3.patch' },
      versions: { [expoImageRule.package]: versionFromKey(expoImageRule.patchedKey) },
      files: { [`${expoImageRule.package}::${expoImageRule.file}`]: postNormalizationGuardSource },
    });

    const result = checkPatchesApplied([expoImageRule], env);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('patch NOT applied');
    expect(result.errors[0]).toContain('hasAbsoluteFilePath');
  });
});
