/// <reference types="node" />

/**
 * Guards against a silently-dropped patch on a native module.
 *
 * `patchedDependencies` in pnpm-workspace.yaml keys each patch by an EXACT
 * version string (e.g. "react-native-screens@4.25.2"). The moment the resolved
 * version drifts off that key — an Expo SDK bump, `pnpm update`, or a transitive
 * floor raise from expo-router — the dependency installs UNPATCHED and only
 * emits a warning. The app still installs, typechecks, and bundles; the only
 * symptom is a missing NATIVE behavior at runtime that no JS check can see.
 *
 * For react-native-screens specifically, the patch adds a
 * `-[UIViewController contentScrollViewForEdge:]` fallback (the
 * `rnscreens_contentScrollViewForEdge` swizzle +
 * `findContentScrollViewInManagedSubtreeFrom` bounded search) so the iOS 26
 * tab-bar minimize tracks the climbs FlashList. Drop the patch and the tab bar
 * just stops minimizing — invisible to typecheck, the Metro bundle, and every
 * existing test, all the way into TestFlight.
 *
 * For @expo/ui, the patch adds the Android `expand()`/`partialExpand()`
 * rejection guard (#3478), the same guard on the `hide()` dismiss path (#4108),
 * and the iOS `onFullyDismissed` post-animation callback. All of it is plain TS
 * that a dropped patch loses just as silently: the Android guards are pure runtime (a
 * dropped patch turns a harmless re-snap into an unhandled rejection on older
 * store binaries, and leaves a dismissed sheet stuck open in JS state) and the
 * iOS wiring is what makes `onFullyDismissed` ever fire. None of it shows up in
 * a bundle.
 *
 * For @expo/fingerprint, the patch makes isolated-linker package roots
 * hashable and gives their files stable logical ids. Without it, Expo mistakes
 * every autolinked native module for a nested node_modules directory and hashes
 * the source as null; peer-resolution store suffixes also leak into hash ids.
 *
 * For expo-image, the patch keeps filesystem-backed board art out of
 * `UIImage(named:)`, avoiding a synchronous bundle-directory scan on every
 * reload before SDWebImage handles the file URL.
 *
 * This check resolves the COPY packages/mobile actually uses (the same one
 * CocoaPods compiles) and asserts the patch's sentinel symbols are present in
 * the installed source. It fails the PR on a cheap Linux runner the instant a
 * patch stops applying — no Xcode required.
 *
 * Usage: vp run check:mobile-patches
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * A substring that must NOT appear inside one specific Objective-C method body.
 *
 * Sentinels prove a patch's symbols survived. This proves its SHAPE survived: a
 * re-keyed patch can keep every sentinel name and still restore the exact line
 * that caused the crash the patch was written for.
 */
export interface ForbiddenInMethod {
  /** Method to anchor on, e.g. `applyBottomAccessoryVisibility`. */
  method: string;
  /** Substrings that must not appear in that method's body (comments stripped). */
  substrings: readonly string[];
  /** Why they're forbidden — printed verbatim in the failure message. */
  why: string;
}

export interface PatchRule {
  /** The patched package — must be a direct dependency of packages/mobile. */
  package: string;
  /** Path, within the installed package, to the source file the patch edits. */
  file: string;
  /** Symbols the patch introduces; ALL must be present in the installed file. */
  sentinels: readonly string[];
  /** Source fragments that must all be present in this exact order. */
  orderedSentinels?: readonly string[];
  /** The exact `patchedDependencies` key expected in pnpm-workspace.yaml. */
  patchedKey: string;
  /** Optional negative assertions scoped to a single method body. */
  forbiddenInMethod?: readonly ForbiddenInMethod[];
}

/**
 * Rules are maintained by hand — one per patched file whose absence no other
 * check would catch. Add a rule when you `pnpm patch` a package and the effect
 * is native-only or runtime-only; a patch whose loss breaks a TYPE is already
 * caught by `typecheck:mobile`, so it doesn't need one.
 *
 * Every rule's package must be a DIRECT dependency of packages/mobile, because
 * {@link createNodeEnv} resolves from packages/mobile/package.json. A patched
 * package that cannot be guarded for that reason must be listed in
 * {@link UNGUARDED_PATCHES} — {@link checkPatchInventory} fails on any patched
 * package that has neither a rule nor an allowlist entry.
 */
export const RULES: readonly PatchRule[] = [
  {
    package: '@expo/fingerprint',
    file: 'build/utils/Path.js',
    sentinels: ['normalizeIsolatedStoreModulePath', 'ISOLATED_STORE_MODULE_ROOT_REGEX'],
    patchedKey: '@expo/fingerprint@0.20.11',
  },
  {
    package: '@expo/fingerprint',
    file: 'build/hash/Hash.js',
    sentinels: ['normalizeIsolatedStoreModulePath'],
    patchedKey: '@expo/fingerprint@0.20.11',
  },
  {
    package: 'react-native-screens',
    file: 'ios/helpers/scroll-view/RNSScrollViewFinder.mm',
    sentinels: [
      'rnscreens_contentScrollViewForEdge',
      'rnscreens_contentScrollViewFallbackInstalled',
      'findContentScrollViewInManagedSubtreeFrom',
      'RNSManagedContentScrollViewSearchMaxDepth',
    ],
    patchedKey: 'react-native-screens@4.26.2',
  },
  // The bottom-accessory attach nudge. The FIRST sentinel alone is not enough:
  // the crashing pre-#4198 version of this patch also defined
  // `rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance`, it just laid
  // out synchronously inside the RN mounting transaction. A patch re-keyed for
  // a react-native-screens bump could reintroduce exactly that and still pass a
  // one-sentinel check, silently regressing BOARDSESH-9K. So the deferral
  // machinery itself is asserted: the coalescing ivar, the out-of-transition
  // helper, and the transition-coordinator hand-off — plus a negative assertion
  // that no synchronous layout crept back into the mounting-transaction path.
  {
    package: 'react-native-screens',
    file: 'ios/tabs/host/RNSTabsHostComponentView.mm',
    sentinels: [
      'rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance',
      'rnscreens_layoutBottomAccessoryOutsideTransition',
      '_rnscreens_bottomAccessoryRelayoutScheduled',
      'animateAlongsideTransition',
    ],
    patchedKey: 'react-native-screens@4.26.2',
    forbiddenInMethod: [
      {
        method: 'applyBottomAccessoryVisibility',
        substrings: ['layoutIfNeeded', 'layoutBelowIfNeeded'],
        why:
          'synchronous layout inside the RN mounting transaction re-enters UITabBar/_minimizeBehavior under a ' +
          'UISheetPresentationController animation — BOARDSESH-9K. Lay out from ' +
          'rnscreens_layoutBottomAccessoryOutsideTransition instead.',
      },
    ],
  },
  // The Android sheet guards are the one hunk NOTHING else can see: they only
  // swallow a native AsyncFunction rejection at runtime when Compose content is
  // unavailable or the native ExpoUI layer predates expand()/partialExpand()/hide().
  // Types are unchanged, so typecheck and the Metro bundle stay green without them.
  //
  // Pin both independently-losable halves: the #3478 expand()/partialExpand()
  // guards, and the complete #4108 dismiss path. The multi-line sentinel ties
  // `.catch(swallowMissingNativeHandler)` to the normalized hide promise inside
  // the helper rather than accepting one of the expand catches as proof. The
  // final two sentinels prove snapToIndex(-1) and close()/forceClose()/dismiss()
  // still funnel through that helper.
  {
    package: '@expo/ui',
    file: 'src/community/bottom-sheet/BottomSheet.android.tsx',
    sentinels: [
      'function swallowMissingNativeHandler(error: unknown): void',
      'sheetRef.current?.expand()?.catch(swallowMissingNativeHandler)',
      'sheetRef.current?.partialExpand()?.catch(swallowMissingNativeHandler)',
      `const hideSwallowingMissingNativeHandler = () => {
      const hidePromise = sheetRef.current?.hide();
      void Promise.resolve(hidePromise)
        .catch(swallowMissingNativeHandler)`,
      'hideSwallowingMissingNativeHandler();',
      'const close = hideSwallowingMissingNativeHandler;',
    ],
    patchedKey: '@expo/ui@57.0.14',
  },
  // The iOS half wires the native post-animation dismiss signal through to the
  // `onFullyDismissed` prop. Drop it and the prop still TYPE-checks (the types
  // hunk lives in the same patch) but silently never fires — LogAscentSheet,
  // ClimbFilterSheet, AddToPlaylistSheet and AddBetaVideoSheet all rely on it.
  {
    package: '@expo/ui',
    file: 'src/community/bottom-sheet/BottomSheet.ios.tsx',
    sentinels: ['onFullyDismissedRef', 'onDismiss={fireCloseCallbacks}', 'coordinator must observe index -1'],
    orderedSentinels: ['onChangeRef.current?.(-1);', 'onFullyDismissedRef.current?.();'],
    patchedKey: '@expo/ui@57.0.14',
  },
  // ExpoModulesCore uses relative file URLs for xcasset names, so
  // `localAssetName` must keep those while rejecting absolute/hosted file URLs
  // before the leading slash is stripped and `UIImage(named:)` synchronously
  // enumerates the bundle for a guaranteed board-art miss (#3928). Silently
  // dropping this patch on the next expo-image bump wouldn't fail typecheck or
  // the bundle — board art would just resume the per-reload main-thread stall.
  {
    package: 'expo-image',
    file: 'ios/ImageView.swift',
    sentinels: [
      'boardsesh/boardsesh#3928',
      'let hasFileHost = url.scheme == "file" && !(url.host?.isEmpty ?? true)',
      'let hasAbsoluteFilePath = url.scheme == "file" && path.hasPrefix("/")',
      'if hasFileHost || hasAbsoluteFilePath',
      'Images/MyIcon',
    ],
    patchedKey: 'expo-image@57.0.3',
  },
];

/**
 * `patchedDependencies` keys that deliberately have NO rule in {@link RULES},
 * each with the reason. {@link checkPatchInventory} fails on any patched
 * package that is in neither list, so adding a patch forces a decision instead
 * of quietly landing unguarded.
 */
export const UNGUARDED_PATCHES: Readonly<Record<string, string>> = {
  'expo-dev-launcher@57.0.16':
    'raises the iOS dev-launcher request timeout from 10s to 120s. Under an isolated linker the package is ' +
    'only reachable through expo-dev-client, so createNodeEnv cannot resolve it from packages/mobile — pnpm does ' +
    "put it in node_modules/.pnpm/node_modules, but that directory is not on packages/mobile's resolution path. " +
    'dev-client-only — it never ships in a store binary.',
};

/**
 * Strip `//` line comments and block comments from Objective-C++ source.
 *
 * The RNSTabsHostComponentView patch documents the crash in prose that quotes
 * `-layoutIfNeeded`, so a negative assertion has to read code only.
 */
function stripObjCComments(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === '//') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (two === '/*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
    } else {
      out += source[index];
      index += 1;
    }
  }
  return out;
}

/**
 * Return the body of Objective-C method `methodName`, comments stripped, or
 * `null` when the method can't be found.
 *
 * Anchors on the `- (…)methodName` / `+ (…)methodName` declaration and then
 * balances braces from the first `{`, so trailing prose after the closing brace
 * (or a following method) is never included. This is a slicer, not a parser:
 * an upstream reformat that breaks the anchor is meant to fail the check loudly
 * so a human re-verifies the patch.
 *
 * A forward declaration — the same signature terminated by `;` inside a class
 * extension, which `RNSTabsHostComponentView.mm` already has two of — is
 * skipped rather than matched. Matching one would slice from the *next* `{` in
 * the file (the `@implementation` ivar block) and quietly scan the wrong text,
 * which for a negative assertion means a silent pass. That is the exact failure
 * this guard exists to prevent, so it must not be possible inside the guard.
 */
export function extractObjCMethodBody(source: string, methodName: string): string | null {
  const stripped = stripObjCComments(source);
  const escaped = methodName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const declarations = new RegExp(String.raw`^[-+]\s*\([^)]*\)\s*${escaped}\b`, 'gm');

  let declaration = declarations.exec(stripped);
  while (declaration !== null) {
    const openBrace = stripped.indexOf('{', declaration.index);
    // Everything between the signature and its body is attributes/whitespace. A
    // `;` in there means this match was a forward declaration, not a definition.
    if (openBrace !== -1 && !stripped.slice(declaration.index, openBrace).includes(';')) {
      let depth = 0;
      for (let index = openBrace; index < stripped.length; index += 1) {
        const character = stripped[index];
        if (character === '{') depth += 1;
        else if (character === '}') {
          depth -= 1;
          if (depth === 0) return stripped.slice(openBrace + 1, index);
        }
      }
      return null;
    }
    declaration = declarations.exec(stripped);
  }
  return null;
}

export interface PatchInventoryInput {
  /** The pnpm-workspace.yaml `patchedDependencies` map (key -> `patches/<file>`). */
  patchedDependencies: Record<string, string>;
  /** Filenames present in patches/ (basenames, not paths). */
  patchFilenames: readonly string[];
  /** `patchedKey` of every entry in {@link RULES}. */
  guardedKeys: readonly string[];
  /** Keys deliberately left unguarded, mapped to the reason. */
  allowUnguarded: Readonly<Record<string, string>>;
}

/**
 * Cross-check `patchedDependencies` against the patches/ directory and RULES.
 *
 * Catches the three things pnpm and the per-rule check do not both cover:
 * a key pointing at a file that isn't there, a patch file left orphaned by a
 * re-key (pnpm never mentions unreferenced files), and a newly patched package
 * that nobody guarded.
 */
export function checkPatchInventory(input: PatchInventoryInput): string[] {
  const errors: string[] = [];
  const present = new Set(input.patchFilenames);
  const referenced = new Set<string>();
  const guarded = new Set(input.guardedKeys);

  for (const [patchedKey, patchPath] of Object.entries(input.patchedDependencies)) {
    const filename = basename(patchPath);
    referenced.add(filename);
    if (!present.has(filename)) {
      errors.push(
        `${patchedKey}: "patchedDependencies" points at ${patchPath}, but that file is not in patches/. ` +
          `pnpm cannot apply a patch it can't read — restore the file or drop the key.`,
      );
    }
    if (!guarded.has(patchedKey) && !Object.prototype.hasOwnProperty.call(input.allowUnguarded, patchedKey)) {
      errors.push(
        `${patchedKey}: patched but unguarded — add a rule to RULES in scripts/mobile-patches-check.ts so a ` +
          `dropped patch fails CI, or add the key to UNGUARDED_PATCHES with the reason it can't be guarded.`,
      );
    }
  }

  for (const filename of input.patchFilenames) {
    if (!referenced.has(filename)) {
      errors.push(
        `patches/${filename}: orphaned — no "patchedDependencies" key references it, so nothing applies it. ` +
          `This is what a re-key leaves behind; delete the stale file or wire it up.`,
      );
    }
  }

  return errors;
}

/**
 * I/O abstracted so {@link checkPatchesApplied} can be unit-tested without a
 * real node_modules tree. The real implementation is {@link createNodeEnv}.
 */
export interface PatchCheckEnv {
  /** The pnpm-workspace.yaml `patchedDependencies` map. */
  patchedDependencies: Record<string, string>;
  /** Installed `version` of `pkg` as resolved from packages/mobile. Throws if unresolvable. */
  readInstalledVersion(pkg: string): string;
  /** Read `fileSubpath` from the installed `pkg` (resolved from packages/mobile). Throws if pkg unresolvable or file absent. */
  readInstalledFile(pkg: string, fileSubpath: string): string;
}

export interface CheckResult {
  /** Number of rules that were checked. */
  checked: number;
  /** Human-readable failure messages; empty means the check passed. */
  errors: string[];
}

/** "react-native-screens@4.25.2" -> "4.25.2"; "@scope/name@1.2.3" -> "1.2.3". */
export function versionFromKey(patchedKey: string): string {
  const at = patchedKey.lastIndexOf('@');
  return at > 0 ? patchedKey.slice(at + 1) : '';
}

/**
 * Pure check: verify every patch rule against the installed tree via `env`.
 * All filesystem/resolution access goes through `env`, so tests inject a fake.
 */
export function checkPatchesApplied(rules: readonly PatchRule[], env: PatchCheckEnv): CheckResult {
  const errors: string[] = [];
  let checked = 0;

  for (const rule of rules) {
    checked += 1;

    // (1) The patch must still be configured at all.
    if (!Object.prototype.hasOwnProperty.call(env.patchedDependencies, rule.patchedKey)) {
      errors.push(
        `${rule.package}: patch no longer configured — expected key "${rule.patchedKey}" in ` +
          `pnpm-workspace.yaml "patchedDependencies". If you intentionally removed it, also delete the rule in ` +
          `scripts/mobile-patches-check.ts and patches/${rule.patchedKey}.patch.`,
      );
      continue;
    }

    // (2) The configured key must match the installed version — pnpm applies a
    //     patch only to its exact key, so any drift means an UNPATCHED install.
    const expectedVersion = versionFromKey(rule.patchedKey);
    let installedVersion: string;
    try {
      installedVersion = env.readInstalledVersion(rule.package);
    } catch (error) {
      errors.push(`${rule.package}: not resolvable from packages/mobile (${(error as Error).message}).`);
      continue;
    }
    if (expectedVersion && installedVersion !== expectedVersion) {
      errors.push(
        `${rule.package}: version drift — installed ${installedVersion}, but "patchedDependencies" targets ` +
          `${expectedVersion}. pnpm keys patches by exact version, so this install is UNPATCHED. Regenerate the ` +
          `patch for ${installedVersion} (\`pnpm patch ${rule.package}@${installedVersion}\`, edit, then ` +
          `\`pnpm patch-commit <dir>\`), update the key + patches/ filename, ` +
          `then re-run this check.`,
      );
      continue;
    }

    // (3) The patch's sentinel symbols must be present in the installed source.
    let source: string;
    try {
      source = env.readInstalledFile(rule.package, rule.file);
    } catch (error) {
      errors.push(`${rule.package}: cannot read patched file ${rule.file} (${(error as Error).message}).`);
      continue;
    }
    const missing = rule.sentinels.filter((sentinel) => !source.includes(sentinel));
    if (missing.length > 0) {
      errors.push(
        `${rule.package}: patch NOT applied — ${rule.file} is missing ${missing.map((s) => `"${s}"`).join(', ')}. ` +
          `Run \`vp install\` to re-apply patches/${rule.patchedKey}.patch; if it no longer applies cleanly, ` +
          `regenerate it with \`pnpm patch ${rule.package}\`.`,
      );
    }

    // (4) Ordered shape assertions: some native contracts depend on callback
    //     sequence, not just the presence of both calls. Keep this in the
    //     shipped check so a re-keyed patch cannot preserve every symbol while
    //     silently reversing the behavior.
    const orderedSentinels = rule.orderedSentinels ?? [];
    const orderedIndexes = orderedSentinels.map((sentinel) => source.indexOf(sentinel));
    const missingOrderedSentinels = orderedSentinels.filter((_, index) => orderedIndexes[index] === -1);
    if (missingOrderedSentinels.length > 0) {
      errors.push(
        `${rule.package}: patch order cannot be verified — ${rule.file} is missing ` +
          `${missingOrderedSentinels.map((sentinel) => `"${sentinel}"`).join(', ')}.`,
      );
    } else {
      for (let index = 1; index < orderedSentinels.length; index += 1) {
        if (orderedIndexes[index - 1] >= orderedIndexes[index]) {
          errors.push(
            `${rule.package}: ${rule.file} violates required source order — ` +
              `"${orderedSentinels[index - 1]}" must appear before "${orderedSentinels[index]}".`,
          );
        }
      }
    }

    // (5) Shape assertions: a symbol can survive a re-keyed patch while the
    //     dangerous line it replaced comes back with it.
    for (const forbidden of rule.forbiddenInMethod ?? []) {
      const body = extractObjCMethodBody(source, forbidden.method);
      if (body === null) {
        errors.push(
          `${rule.package}: cannot locate -[${forbidden.method}] in ${rule.file}, so its safety assertion could not ` +
            `run. Upstream moved or reshaped the anchor — re-verify patches/${rule.patchedKey}.patch by hand and ` +
            `update the rule in scripts/mobile-patches-check.ts. Do not delete the assertion to get green.`,
        );
        continue;
      }
      const found = forbidden.substrings.filter((substring) => body.includes(substring));
      if (found.length > 0) {
        errors.push(
          `${rule.package}: ${rule.file} has ${found.map((s) => `"${s}"`).join(', ')} inside -[${forbidden.method}], ` +
            `which the patch exists to remove — ${forbidden.why}`,
        );
      }
    }
  }

  return { checked, errors };
}

/** Real-filesystem env used when the script runs for real. */
export function createNodeEnv(mobilePackageJson: string, patchedDependencies: Record<string, string>): PatchCheckEnv {
  const requireFromMobile = createRequire(mobilePackageJson);
  const resolvePackageJson = (pkg: string) => requireFromMobile.resolve(`${pkg}/package.json`);
  return {
    patchedDependencies,
    readInstalledVersion(pkg) {
      const { version } = JSON.parse(readFileSync(resolvePackageJson(pkg), 'utf8')) as { version?: string };
      if (!version) throw new Error(`no "version" field in ${pkg}/package.json`);
      return version;
    },
    readInstalledFile(pkg, fileSubpath) {
      return readFileSync(resolve(dirname(resolvePackageJson(pkg)), fileSubpath), 'utf8');
    },
  };
}

/** Wire the real filesystem and run the check. Returns the process exit code. */
export function main(): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const mobilePackageJson = resolve(repoRoot, 'packages', 'mobile', 'package.json');

  let patchedDependencies: Record<string, string>;
  try {
    const workspaceManifest = parseYaml(readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8')) as {
      patchedDependencies?: Record<string, string>;
    };
    patchedDependencies = workspaceManifest.patchedDependencies ?? {};
  } catch (error) {
    console.error(`[mobile-patches] FAILED — cannot read pnpm-workspace.yaml: ${(error as Error).message}`);
    return 1;
  }

  let patchFilenames: string[];
  try {
    patchFilenames = readdirSync(resolve(repoRoot, 'patches')).filter((name) => name.endsWith('.patch'));
  } catch (error) {
    console.error(`[mobile-patches] FAILED — cannot read patches/: ${(error as Error).message}`);
    return 1;
  }

  const env = createNodeEnv(mobilePackageJson, patchedDependencies);
  const { checked, errors } = checkPatchesApplied(RULES, env);
  const inventoryErrors = checkPatchInventory({
    patchedDependencies,
    patchFilenames,
    guardedKeys: RULES.map((rule) => rule.patchedKey),
    allowUnguarded: UNGUARDED_PATCHES,
  });
  const allErrors = [...errors, ...inventoryErrors];

  if (allErrors.length > 0) {
    console.error('[mobile-patches] FAILED — native patch(es) not applied:');
    for (const error of allErrors) console.error(`  ✗ ${error}`);
    return 1;
  }

  console.log(
    `[mobile-patches] OK — ${checked} native patch(es) applied, ${patchFilenames.length} patch file(s) accounted for.`,
  );
  return 0;
}

// Run only when executed directly (tsx scripts/mobile-patches-check.ts), not
// when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
