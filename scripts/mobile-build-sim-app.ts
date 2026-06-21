/// <reference types="node" />

/**
 * Builds a Debug iOS *simulator* dev-client app (.app) for the screenshots
 * pipeline and copies it to --app-out.
 *
 * Why this exists as a separate, cacheable step: the screenshot app is a
 * dev-client shell that loads its JS from Metro at runtime (see
 * scripts/mobile-screenshots.ts). The screenshot behaviour
 * (EXPO_PUBLIC_SCREENSHOT_MODE, theme, workout) is baked into the Metro JS
 * bundle, NOT the native binary, so this .app only changes when *native* inputs
 * change — Expo/RN/native-module versions, app.config.ts, plugins/**,
 * modules/**, patches/**. CI caches the finished .app keyed on those inputs
 * (actions/cache) and reuses it across JS-only runs, turning a ~30-min
 * from-scratch compile into a ~5-min install + Metro + Maestro run.
 *
 * It builds with `xcodebuild build` (NOT `expo run:ios`, whose post-install
 * launch step opens a dev-client URL and hangs in CI), so it runs to completion
 * and emits a cacheable product. Debug config means the app loads from Metro
 * rather than embedding a frozen bundle.
 *
 * Usage:
 *   vp run mobile:build-sim-app -- --app-out <dir> [--clean] [--configuration Debug]
 *
 * Requires: macOS + Xcode + CocoaPods.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');
const IOS_DIR = resolve(MOBILE_DIR, 'ios');
const DERIVED_DATA_DIR = resolve(IOS_DIR, 'build');
const WORKSPACE_PATH = resolve(IOS_DIR, 'Boardsesh.xcworkspace');
const SCHEME = 'Boardsesh';
// Literal entitlements for the sim build — see the file's comment for why the
// generated ones can't be used (profile-dependent $(AppIdentifierPrefix)).
const SIM_ENTITLEMENTS = resolve(ROOT_DIR, 'scripts', 'screenshot-sim.entitlements');
const APP_NAME = 'Boardsesh.app';
const DEFAULT_APP_OUT = resolve(MOBILE_DIR, '.app-cache');
const LOG = '[mobile:build-sim-app]';

export interface BuildSimAppOptions {
  appOut: string;
  clean: boolean;
  configuration: string;
}

export function parseArgs(argv: readonly string[]): BuildSimAppOptions {
  const args = argv.filter((argument) => argument !== '--');
  const options: BuildSimAppOptions = {
    appOut: DEFAULT_APP_OUT,
    clean: false,
    configuration: 'Debug',
  };

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case '--app-out':
        options.appOut = resolve(expectValue(flag, value));
        index++;
        break;
      case '--configuration':
        options.configuration = expectValue(flag, value);
        index++;
        break;
      case '--clean':
        options.clean = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return options;
}

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function run(command: string, args: string[], cwd: string): number {
  console.log(`${LOG} $ ${command} ${args.join(' ')} (cwd: ${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env } });
  return result.status ?? 1;
}

/** The Debug simulator product xcodebuild writes under -derivedDataPath. */
export function builtAppPath(configuration: string): string {
  return join(DERIVED_DATA_DIR, 'Build', 'Products', `${configuration}-iphonesimulator`, APP_NAME);
}

function expoPrebuild(clean: boolean): void {
  // `--no-install` so pod install is an explicit, separately-logged step (a
  // common CI failure point).
  const prebuildArgs = ['expo', 'prebuild', '--platform', 'ios', '--no-install'];
  if (clean) prebuildArgs.push('--clean');
  const status = run('bunx', prebuildArgs, MOBILE_DIR);
  if (status !== 0) {
    throw new Error(`expo prebuild failed with exit code ${status}`);
  }
}

function ensureNativeProject(clean: boolean): void {
  if (clean) {
    // CI / deterministic: wipe ios/ and regenerate from scratch. --clean is
    // REQUIRED for this project, not just nice-to-have: an *incremental* prebuild
    // over an existing ios/ crashes in @bacons/apple-targets — it tries to
    // "update" the already-present BoardseshWidgets target and throws
    // ("Cannot read properties of undefined (reading 'removeFromProject')").
    // A clean run CREATES the target fresh, so it never hits that path.
    expoPrebuild(true);
    return;
  }
  if (existsSync(WORKSPACE_PATH)) {
    // ios/ already generated (e.g. by `vp run mobile:ios`). Skip prebuild — see
    // the incremental-crash note above — and trust the existing project. The dev
    // owns ios/ freshness locally; CI always passes --clean. Pass --clean here to
    // force a regenerate after a native-config change.
    console.log(`${LOG} Reusing existing ios/ project (skip prebuild). Pass --clean to regenerate.`);
    return;
  }
  // No project yet → generate it. ios/ is absent, so this is effectively clean
  // (apple-targets CREATES the widget target) and won't hit the update crash.
  expoPrebuild(false);
}

function podInstall(): void {
  const status = run('pod', ['install'], IOS_DIR);
  if (status !== 0) {
    throw new Error(`pod install failed with exit code ${status}`);
  }
}

function xcodebuild(configuration: string): number {
  return run(
    'xcodebuild',
    [
      'build',
      '-workspace',
      WORKSPACE_PATH,
      '-scheme',
      SCHEME,
      '-configuration',
      configuration,
      '-destination',
      'generic/platform=iOS Simulator',
      '-derivedDataPath',
      DERIVED_DATA_DIR,
      // Ad-hoc sign with LITERAL entitlements: the app must carry a
      // keychain-access-group or expo-secure-store fails ("a required entitlement
      // isn't present"), so the auth token can't persist and login fails. The
      // generated entitlements use $(AppIdentifierPrefix), which only resolves
      // from a provisioning profile a simulator build doesn't have — Xcode then
      // strips them to nothing. SIM_ENTITLEMENTS uses literal values the sim
      // accepts. Ad-hoc signing ("-") needs no team/profile. Applied to every
      // target (the widget + share extension also build under this scheme); the
      // sim doesn't enforce extra keychain groups, so that's harmless.
      'CODE_SIGN_IDENTITY=-',
      `CODE_SIGN_ENTITLEMENTS=${SIM_ENTITLEMENTS}`,
      // arm64 only: macos-26 runners and Boardsesh dev machines are all Apple
      // Silicon, so building the x86_64 sim slice just doubles the time (and can
      // fail on a pod that lacks x86_64-sim support) for an arch nothing installs.
      // The actions/cache key pins runner.arch, so a future arch change busts it.
      'ARCHS=arm64',
    ],
    IOS_DIR,
  );
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  let options: BuildSimAppOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (process.platform !== 'darwin') {
    console.log(`${LOG} Skipped: simulator builds require macOS + Xcode.`);
    return 0;
  }

  // Tells app.config.ts to register ./plugins/with-screenshot-dev-menu, which
  // bakes dev-menu suppression into Info.plist so the dev-client chrome can't
  // cover the captured screens on a cold relaunch. Read at prebuild time.
  process.env.BOARDSESH_SCREENSHOT_BUILD = '1';

  try {
    ensureNativeProject(options.clean);
    podInstall();

    let status = xcodebuild(options.configuration);
    const appPath = builtAppPath(options.configuration);
    if (status !== 0 && !existsSync(appPath)) {
      // RN New Architecture codegen ("Generate Specs") can race the compile on a
      // cold/clean build ("Build input file cannot be found: …/ReactCodegen/
      // *-generated.mm"). The specs land during that first attempt, so a second
      // build finds them — the well-known "build twice on a clean checkout"
      // quirk that bites every fresh CI runner. Retry once.
      console.log(
        `${LOG} First build failed without producing the .app (likely the cold-build codegen race); retrying once...`,
      );
      status = xcodebuild(options.configuration);
    }

    if (!existsSync(appPath)) {
      console.error(`${LOG} FAILED: ${appPath} not found after build (exit ${status}).`);
      return status === 0 ? 1 : status;
    }

    mkdirSync(options.appOut, { recursive: true });
    const destination = join(options.appOut, APP_NAME);
    rmSync(destination, { force: true, recursive: true });
    cpSync(appPath, destination, { recursive: true });
    console.log(`${LOG} Built ${options.configuration} simulator app -> ${destination}`);
    return 0;
  } catch (error) {
    console.error(`${LOG} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
