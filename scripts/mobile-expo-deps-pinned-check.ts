/// <reference types="node" />

/**
 * Guards that every Expo-published dependency in packages/mobile is EXACT-pinned
 * (no ^ ~ * x / range). This intentionally covers the whole `@expo/*` scope plus
 * `expo` / `expo-*` — not just the native modules — because the repo already
 * exact-pins all of them and stricter is safer here: a ranged Expo package (even
 * pure-JS tooling that affects prebuild) is a reproducibility hazard, and a
 * ranged native module is a JS/native drift hazard.
 *
 * The drift case is what motivated this check: a `~`/`^` range lets a later
 * (non-frozen) `vp install` float the JS ahead of the version a shipped binary's
 * native layer was built against. Normally the OTA runtimeVersion fingerprint
 * would refuse the mismatched bundle — but this app pins the fingerprint via
 * EXPO_UPDATES_FINGERPRINT_OVERRIDE (app.config.ts), so the drifted JS still lands
 * on the old binary. That is exactly what produced the
 * `ModalBottomSheetView.partialExpand` "No handler registered" crash: a
 * `~56.0.18`-pinned @expo/ui floated the JS `partialExpand()` call ahead of a
 * binary whose native layer never registered that AsyncFunction.
 *
 * Non-Expo React Native deps are intentionally NOT covered — some pin with `~`
 * on purpose (e.g. react-native-gesture-handler, react-native-safe-area-context).
 * If a genuinely range-safe pure-JS `@expo/*` dev tool ever needs a range, add an
 * explicit allowlist here rather than loosening the whole rule.
 *
 * Usage: vp run check:mobile-expo-deps-pinned
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readMobileDeps } from './mobile-native-deps-check';

// A version with no range operator: X.Y.Z plus an optional -prerelease. Anything
// carrying ^ ~ * x, a hyphen range, or a `||` union is treated as unpinned.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** An Expo-published package: the `@expo/*` scope or an `expo` / `expo-*` name. */
export function isExpoPackage(name: string): boolean {
  return name.startsWith('@expo/') || name === 'expo' || name.startsWith('expo-');
}

/**
 * Pure: the `name@spec` of every Expo package whose spec is not exact-pinned.
 * Empty means all Expo packages are pinned. No filesystem access — the caller
 * passes the merged dependency map, so this is directly unit-testable.
 */
export function findUnpinnedExpoDeps(deps: Record<string, string>): string[] {
  return Object.entries(deps)
    .filter(([name, spec]) => isExpoPackage(name) && !EXACT_VERSION.test(spec.trim()))
    .map(([name, spec]) => `${name}@${spec}`);
}

/** Wire the real filesystem and run the check. Returns the process exit code. */
export function main(): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const mobilePackageJson = resolve(repoRoot, 'packages', 'mobile', 'package.json');

  let mobileDeps: Record<string, string>;
  try {
    mobileDeps = readMobileDeps(mobilePackageJson);
  } catch (error) {
    console.error(`[mobile-expo-deps-pinned] FAILED — ${(error as Error).message}`);
    return 1;
  }

  const unpinned = findUnpinnedExpoDeps(mobileDeps);
  if (unpinned.length > 0) {
    console.error('[mobile-expo-deps-pinned] FAILED — these Expo packages must be exact-pinned (no ^ ~ * / range):');
    for (const dep of unpinned) console.error(`  ✗ ${dep}`);
    console.error(
      '  An Expo native module ships a JS + native pair; a range lets the JS drift ahead of a shipped\n' +
        "  binary's native layer (the ModalBottomSheetView.partialExpand crash). Pin to the exact version.",
    );
    return 1;
  }

  const count = Object.keys(mobileDeps).filter(isExpoPackage).length;
  console.log(`[mobile-expo-deps-pinned] OK — all ${count} Expo package(s) exact-pinned.`);
  return 0;
}

// Run only when executed directly (tsx scripts/mobile-expo-deps-pinned-check.ts),
// not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
