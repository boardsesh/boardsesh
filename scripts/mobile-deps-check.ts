/// <reference types="node" />

/**
 * Deterministic dep-health check for packages/mobile: validates our declared
 * pins against the INSTALLED SDK's bundledNativeModules.json (never the
 * network, unlike `expo install --check`), so it only changes outcome when we
 * bump expo, edit a pin, or the lockfile drifts.
 *
 * Usage: vp run check:mobile-deps
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import { readMobileDeps } from './mobile-native-deps-check';

export const EXPO_PACKAGE_NAME = 'expo';

export interface DepViolation {
  package: string;
  declared: string;
  /** SDK's bundled range, or null for `expo` itself (untracked). */
  bundled: string | null;
  installed: string | null;
  reason: string;
}

export interface DepCheckResult {
  /** Deps validated against the bundled map; 0 means a degenerate map must fail the run. */
  checked: number;
  violations: DepViolation[];
}

// Pure check (no filesystem). Exclusion ≠ exempt from drift: it skips only the
// bundled-range rule; installed-satisfies-declared still runs for excluded packages.
export function checkMobileDeps(
  declaredDeps: Record<string, string>,
  exclude: readonly string[],
  bundledModules: Record<string, string>,
  installedVersions: Record<string, string | undefined>,
  expoPackageName: string = EXPO_PACKAGE_NAME,
): DepCheckResult {
  const excludeSet = new Set(exclude);
  const violations: DepViolation[] = [];
  let checked = 0;

  for (const [name, declared] of Object.entries(declaredDeps)) {
    const isExpoItself = name === expoPackageName;
    const bundledRange = isExpoItself ? undefined : bundledModules[name];
    if (!isExpoItself && bundledRange === undefined) continue; // not tracked by the SDK

    if (bundledRange !== undefined && !excludeSet.has(name)) {
      // (1) Declared-range alignment.
      checked += 1;
      const declaredIsExact = semver.valid(declared) !== null;
      if (declaredIsExact) {
        if (!semver.satisfies(declared, bundledRange)) {
          violations.push({
            package: name,
            declared,
            bundled: bundledRange,
            installed: installedVersions[name] ?? null,
            reason: `declared "${declared}" does not satisfy the SDK's bundled range "${bundledRange}"`,
          });
        }
      } else if (declared !== bundledRange) {
        violations.push({
          package: name,
          declared,
          bundled: bundledRange,
          installed: installedVersions[name] ?? null,
          reason:
            `declared range "${declared}" does not match the SDK's bundled range "${bundledRange}" — ` +
            `pin exactly or match the SDK's range string`,
        });
      }
    }

    // (2) Installed alignment — the caret-drift class of bug that crashed the
    // 2.0.0 launch: a ^/~ range silently resolving to a version the installed
    // Expo SDK was never tested against, invisible to typecheck and Metro.
    const installed = installedVersions[name];
    if (installed === undefined) {
      violations.push({
        package: name,
        declared,
        bundled: bundledRange ?? null,
        installed: null,
        reason: `not installed / not resolvable from packages/mobile (run 'vp install')`,
      });
    } else if (!semver.satisfies(installed, declared)) {
      violations.push({
        package: name,
        declared,
        bundled: bundledRange ?? null,
        installed,
        reason: `installed "${installed}" does not satisfy declared "${declared}" — lockfile drift`,
      });
    }
  }

  return { checked, violations };
}

/** Read `expo.install.exclude`; throws on a non-array or non-string entries (fail loud, don't mis-exclude). */
export function readExcludeList(mobilePackageJsonPath: string): string[] {
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
  const pkg = parsed as { expo?: { install?: { exclude?: unknown } } };
  const exclude = pkg.expo?.install?.exclude;
  if (exclude === undefined) return [];
  if (!Array.isArray(exclude)) {
    throw new Error(
      `expo.install.exclude in ${mobilePackageJsonPath} must be an array of package names, got ${typeof exclude}`,
    );
  }
  const nonString = exclude.find((entry) => typeof entry !== 'string');
  if (nonString !== undefined) {
    throw new Error(
      `expo.install.exclude in ${mobilePackageJsonPath} must contain only strings, got ${JSON.stringify(nonString)}`,
    );
  }
  return exclude as string[];
}

/** Read the installed SDK's pins map; throws on missing or degenerate (empty / array / non-string) input. */
export function readBundledNativeModules(bundledNativeModulesPath: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(bundledNativeModulesPath, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read ${bundledNativeModulesPath}: ${(error as Error).message}. ` +
        `Run 'vp install' in the repo root so packages/mobile/node_modules/expo is populated.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${bundledNativeModulesPath}: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${bundledNativeModulesPath} is not a JSON object — the installed expo package looks corrupt`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(
      `${bundledNativeModulesPath} is empty — an empty pins map would validate nothing. ` +
        `The installed expo package looks corrupt; re-run 'vp install'.`,
    );
  }
  const nonString = entries.find(([, range]) => typeof range !== 'string');
  if (nonString) {
    throw new Error(
      `${bundledNativeModulesPath} has a non-string range for "${nonString[0]}" — ` +
        `the installed expo package looks corrupt`,
    );
  }
  return parsed as Record<string, string>;
}

// Reads manifests straight off disk, not require.resolve('<pkg>/package.json'):
// some SDK packages' exports maps (e.g. expo-symbols) make that unresolvable.
export function readInstalledVersion(searchDirs: readonly string[], name: string): string | undefined {
  for (const dir of searchDirs) {
    const packageJsonPath = resolve(dir, ...name.split('/'), 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    try {
      const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
      if (version) return version;
    } catch {
      // Malformed manifest here — try the next search dir.
    }
  }
  return undefined;
}

export function readInstalledVersions(
  searchDirs: readonly string[],
  packageNames: readonly string[],
): Record<string, string | undefined> {
  const versions: Record<string, string | undefined> = {};
  for (const name of packageNames) {
    versions[name] = readInstalledVersion(searchDirs, name);
  }
  return versions;
}

/** Wire the real filesystem and run the check. Returns the process exit code. */
export function main(): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const mobileDir = resolve(repoRoot, 'packages', 'mobile');
  const mobilePackageJson = resolve(mobileDir, 'package.json');
  const bundledNativeModulesPath = resolve(mobileDir, 'node_modules', 'expo', 'bundledNativeModules.json');
  // pnpm's isolated linker: direct deps in packages/mobile/node_modules, root-package deps at the root.
  const searchDirs = [resolve(mobileDir, 'node_modules'), resolve(repoRoot, 'node_modules')];

  let declaredDeps: Record<string, string>;
  let exclude: string[];
  let bundledModules: Record<string, string>;
  try {
    declaredDeps = readMobileDeps(mobilePackageJson);
    exclude = readExcludeList(mobilePackageJson);
    bundledModules = readBundledNativeModules(bundledNativeModulesPath);
  } catch (error) {
    console.error(`[mobile-deps] FAILED — ${(error as Error).message}`);
    return 1;
  }

  const installedVersions = readInstalledVersions(searchDirs, Object.keys(declaredDeps));
  const installedExpoVersion = installedVersions[EXPO_PACKAGE_NAME];
  const { checked, violations } = checkMobileDeps(declaredDeps, exclude, bundledModules, installedVersions);

  if (checked === 0) {
    console.error(
      `[mobile-deps] FAILED — 0 declared dependencies were validated against ${bundledNativeModulesPath}. ` +
        `Either the pins map is degenerate or every tracked dependency is excluded; ` +
        `this check must verify something to pass.`,
    );
    return 1;
  }

  if (violations.length > 0) {
    console.error(`[mobile-deps] FAILED — ${violations.length} dependency violation(s) against the installed SDK:`);
    for (const violation of violations) {
      console.error(
        `  ✗ ${violation.package}: declared=${violation.declared} bundled=${violation.bundled ?? 'n/a'} ` +
          `installed=${violation.installed ?? 'MISSING'} — ${violation.reason}`,
      );
    }
    console.error(
      '[mobile-deps] Pin each flagged package to the version the SDK bundles, run `vp install` to fix ' +
        'lockfile drift, or, if the deviation is intentional, add it to expo.install.exclude in ' +
        'packages/mobile/package.json.',
    );
    return 1;
  }

  console.log(
    `[mobile-deps] OK — ${checked} dependencies match Expo SDK ${installedExpoVersion ?? '(unknown)'}'s ` +
      'bundled pins (or are explicitly excluded), and all installed versions satisfy their declared pins.',
  );
  return 0;
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
