/// <reference types="node" />

/**
 * Guards against a silently-dropped Bun patch on a native module.
 *
 * `patchedDependencies` in the root package.json keys each patch by an EXACT
 * version string (e.g. "react-native-screens@4.25.2"). The moment the resolved
 * version drifts off that key — an Expo SDK bump, `bun update`, or a transitive
 * floor raise from expo-router — Bun installs the dependency UNPATCHED and only
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
 * This check resolves the COPY packages/mobile actually uses (the same one
 * CocoaPods compiles) and asserts the patch's sentinel symbols are present in
 * the installed source. It fails the PR on a cheap Linux runner the instant a
 * patch stops applying — no Xcode required.
 *
 * Usage: vp run check:mobile-patches
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface PatchRule {
  /** The patched package — must be a direct dependency of packages/mobile. */
  package: string;
  /** Path, within the installed package, to the source file the patch edits. */
  file: string;
  /** Symbols the patch introduces; ALL must be present in the installed file. */
  sentinels: readonly string[];
  /** The exact `patchedDependencies` key expected in the root package.json. */
  patchedKey: string;
}

/**
 * Rules are maintained by hand — one per patched native module whose absence is
 * invisible to JS-level checks. Add a rule when you `bun patch` a package whose
 * effect is native-only (the JS side would catch a missing JS patch on its own).
 */
export const RULES: readonly PatchRule[] = [
  {
    package: 'react-native-screens',
    file: 'ios/helpers/scroll-view/RNSScrollViewFinder.mm',
    sentinels: [
      'rnscreens_contentScrollViewForEdge',
      'rnscreens_contentScrollViewFallbackInstalled',
      'findContentScrollViewInManagedSubtreeFrom',
      'RNSManagedContentScrollViewSearchMaxDepth',
    ],
    patchedKey: 'react-native-screens@4.25.2',
  },
  {
    package: 'react-native-screens',
    file: 'ios/tabs/host/RNSTabsHostComponentView.mm',
    sentinels: ['rnscreens_relayoutBottomAccessoryIfAttachedAfterAppearance'],
    patchedKey: 'react-native-screens@4.25.2',
  },
];

/**
 * I/O abstracted so {@link checkPatchesApplied} can be unit-tested without a
 * real node_modules tree. The real implementation is {@link createNodeEnv}.
 */
export interface PatchCheckEnv {
  /** The root package.json `patchedDependencies` map. */
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
        `${rule.package}: patch no longer configured — expected key "${rule.patchedKey}" in the root ` +
          `package.json "patchedDependencies". If you intentionally removed it, also delete the rule in ` +
          `scripts/mobile-patches-check.ts and patches/${rule.patchedKey}.patch.`,
      );
      continue;
    }

    // (2) The configured key must match the installed version — Bun applies a
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
          `${expectedVersion}. Bun keys patches by exact version, so this install is UNPATCHED. Regenerate the ` +
          `patch for ${installedVersion} (\`bun patch ${rule.package}\`), update the key + patches/ filename, ` +
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
          `Run \`bun install\` to re-apply patches/${rule.patchedKey}.patch; if it no longer applies cleanly, ` +
          `regenerate it with \`bun patch ${rule.package}\`.`,
      );
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
    const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      patchedDependencies?: Record<string, string>;
    };
    patchedDependencies = rootPkg.patchedDependencies ?? {};
  } catch (error) {
    console.error(`[mobile-patches] FAILED — cannot read root package.json: ${(error as Error).message}`);
    return 1;
  }

  const env = createNodeEnv(mobilePackageJson, patchedDependencies);
  const { checked, errors } = checkPatchesApplied(RULES, env);

  if (errors.length > 0) {
    console.error('[mobile-patches] FAILED — native patch(es) not applied:');
    for (const error of errors) console.error(`  ✗ ${error}`);
    return 1;
  }

  console.log(`[mobile-patches] OK — ${checked} native patch(es) applied.`);
  return 0;
}

// Run only when executed directly (tsx scripts/mobile-patches-check.ts), not
// when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
