/// <reference types="node" />

/**
 * Guards against native iOS build-phase dependency-resolution breaks that only
 * surface during the macOS `xcodebuild archive` on push-to-main (e.g. the
 * TestFlight RN deploy), long after the PR that caused them merged.
 *
 * The iOS "Bundle React Native code and images" phase shells out to helper
 * scripts that resolve CLIs with Node from inside packages/mobile — most
 * notably Sentry's `sentry-xcode.sh`, which runs:
 *
 *   node --print "require.resolve('@sentry/cli/package.json')"
 *
 * pnpm's isolated linker only symlinks a workspace's DIRECT deps into its
 * node_modules, so a transitive-only `@sentry/cli` (pulled in by
 * @sentry/react-native) is NOT resolvable from packages/mobile and the build
 * dies under `set -e`. The fix is to declare such tools as direct deps; this
 * check fails the PR the moment that invariant is broken, on a cheap Linux
 * runner — no Xcode required.
 *
 * It enforces two invariants per rule:
 *   1. Resolvable — the tool resolves from packages/mobile (the exact thing the
 *      bundle phase does). This is what broke the TestFlight archive.
 *   2. Version-aligned — the copy packages/mobile resolves is the SAME install
 *      the trigger package resolves. The direct pin we add to dedupe will
 *      silently drift from the trigger's transitive requirement when either is
 *      bumped; this catches that so the bundle phase and the JS runtime never
 *      use mismatched CLI versions.
 *
 * Usage: vp run check:mobile-native-deps
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface NativeDepRule {
  /** A direct dependency of packages/mobile whose Expo config plugin injects an iOS build-phase script. */
  trigger: string;
  /** Bare module specifiers that build-phase script resolves via Node from packages/mobile. */
  tools: readonly string[];
}

/**
 * Rules are MAINTAINED BY HAND. There is no way to enumerate every CLI an iOS
 * build phase shells out to without running `expo prebuild` + xcodebuild (macOS
 * only, which defeats the point of a cheap Linux guard). So when a new native
 * dep adds an Expo config plugin that injects a build-phase `require.resolve`,
 * add a rule here — otherwise that tool's drift won't be caught until the next
 * push-to-main archive. Today only @sentry/react-native does this.
 */
export const RULES: readonly NativeDepRule[] = [{ trigger: '@sentry/react-native', tools: ['@sentry/cli'] }];

/**
 * Resolution + version reads, abstracted so {@link checkNativeBuildPhaseDeps}
 * can be unit-tested without a real node_modules tree.
 */
export interface DepResolver {
  /** Resolve `request` as Node would when required from the package at `fromPackageJson`. Throws if unresolvable. */
  resolve(fromPackageJson: string, request: string): string;
  /** Read the `version` field of an installed package.json. Throws if absent/unreadable. */
  readVersion(packageJsonPath: string): string;
}

export interface CheckResult {
  /** Number of (rule, tool) pairs that were applicable and checked. */
  checked: number;
  /** Human-readable failure messages; empty means the check passed. */
  errors: string[];
}

/**
 * Pure check: given the mobile dependency map and a resolver, verify every
 * applicable rule. No filesystem access of its own — all I/O goes through
 * `resolver`, so tests inject a fake.
 */
export function checkNativeBuildPhaseDeps(
  mobilePackageJsonPath: string,
  mobileDeps: Record<string, string>,
  rules: readonly NativeDepRule[],
  resolver: DepResolver,
): CheckResult {
  const errors: string[] = [];
  let checked = 0;

  for (const { trigger, tools } of rules) {
    if (!mobileDeps[trigger]) continue;
    for (const tool of tools) {
      checked += 1;

      // (1) Resolvability from packages/mobile — exactly what the iOS bundle
      //     phase does, and the failure that broke the TestFlight archive.
      let toolFromMobile: string;
      try {
        toolFromMobile = resolver.resolve(mobilePackageJsonPath, `${tool}/package.json`);
      } catch {
        errors.push(
          `${tool} is required at iOS build time by ${trigger}, but is not resolvable from ` +
            `packages/mobile. Add it as a direct dependency in packages/mobile/package.json ` +
            `(pnpm's isolated linker does not surface transitive deps there).`,
        );
        continue; // Can't check alignment if it doesn't resolve at all.
      }

      // (2) Version alignment — compare the copy packages/mobile resolves with
      //     the copy `trigger` resolves. Equal install path-version means one
      //     deduped copy; a mismatch means the direct pin drifted from what the
      //     trigger now requires.
      try {
        const triggerPackageJson = resolver.resolve(mobilePackageJsonPath, `${trigger}/package.json`);
        const toolFromTrigger = resolver.resolve(triggerPackageJson, `${tool}/package.json`);
        const mobileVersion = resolver.readVersion(toolFromMobile);
        const triggerVersion = resolver.readVersion(toolFromTrigger);
        if (mobileVersion !== triggerVersion) {
          errors.push(
            `${tool} version drift: packages/mobile resolves ${mobileVersion}, but ${trigger} ` +
              `resolves ${triggerVersion}. Update the direct "${tool}" pin in ` +
              `packages/mobile/package.json to ${triggerVersion} so both use one copy.`,
          );
        }
      } catch (error) {
        errors.push(`could not verify ${tool} version alignment against ${trigger}: ${(error as Error).message}`);
      }
    }
  }

  return { checked, errors };
}

/**
 * Read and merge the dependency maps of packages/mobile's package.json.
 * devDependencies first so a real dependency entry wins on conflict.
 */
export function readMobileDeps(mobilePackageJsonPath: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(mobilePackageJsonPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${mobilePackageJsonPath}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${mobilePackageJsonPath}: ${(error as Error).message}`);
  }
  const pkg = parsed as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  return { ...pkg.devDependencies, ...pkg.dependencies };
}

/** Real-filesystem resolver used when the script runs for real. */
export const nodeResolver: DepResolver = {
  resolve(fromPackageJson, request) {
    return createRequire(fromPackageJson).resolve(request);
  },
  readVersion(packageJsonPath) {
    const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    if (!version) throw new Error(`no "version" field in ${packageJsonPath}`);
    return version;
  },
};

/** Wire the real filesystem and run the check. Returns the process exit code. */
export function main(): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const mobilePackageJson = resolve(repoRoot, 'packages', 'mobile', 'package.json');

  let mobileDeps: Record<string, string>;
  try {
    mobileDeps = readMobileDeps(mobilePackageJson);
  } catch (error) {
    console.error(`[mobile-native-deps] FAILED — ${(error as Error).message}`);
    return 1;
  }

  const { checked, errors } = checkNativeBuildPhaseDeps(mobilePackageJson, mobileDeps, RULES, nodeResolver);

  if (errors.length > 0) {
    console.error('[mobile-native-deps] FAILED — native build-phase deps not OK:');
    for (const error of errors) console.error(`  ✗ ${error}`);
    return 1;
  }

  console.log(`[mobile-native-deps] OK — ${checked} native build-phase dep(s) resolvable and version-aligned.`);
  return 0;
}

// Run only when executed directly (tsx scripts/mobile-native-deps-check.ts),
// not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
