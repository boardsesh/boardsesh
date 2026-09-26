/// <reference types="node" />

/**
 * Asks the self-hosted xprem update server the same question a device asks, and
 * says why the mobile "Test a PR" screen is empty.
 *
 * The screen (packages/mobile/src/components/qa/QaPickScreen.tsx) renders exactly
 * three states, and they come straight off `GET /branch_lists`:
 *
 *   404 + `xprem-branch-surfing` header → "Previews are switched off"
 *   200 with an empty list             → "Nothing to test right now"
 *   200 with branches                  → the PR list
 *
 * Telling those apart used to need a device, a tester account, and a TestFlight
 * build. It doesn't: `/branch_lists` is an unauthenticated DEVICE endpoint, so
 * this script reproduces the call from a laptop with no credentials at all.
 *
 * The subtle failure this exists for is the third one. `/branch_lists` filters on
 * the device's EXACT runtimeVersion and platform, so a `pr-<n>` branch published
 * before a native change landed on `main` is invisible to every current binary —
 * the switch is on, the branch exists, and the tester still sees an empty list.
 * That is why `--runtime-version` matters more than it looks: probe with the wrong
 * fingerprint and you get a perfectly healthy-looking empty list.
 *
 * Usage:
 *   vp run mobile:ota-surf-doctor                                    # is the switch on?
 *   vp run mobile:ota-surf-doctor -- --platform ios --runtime-version <hash>
 *   vp run mobile:ota-surf-doctor -- --platform ios --json
 *
 * With no --runtime-version it answers only the switch question, because that one
 * is a property of the channel. The branch list is filtered by exact
 * runtimeVersion + platform, so seeing it needs the hash a native build baked
 * (its EXPO_UPDATES_FINGERPRINT_OVERRIDE) — and iOS and Android differ.
 *
 * Exit codes:
 *   0  surfing is on (whether or not any branch matched — an empty list is a
 *      diagnosis, not a build failure)
 *   1  surfing is off for the channel, or the server could not be reached
 *
 * Env:
 *   OTA_BASE_URL / EXPO_UPDATES_URL  optional — defaults to the production server.
 *   EXPO_UPDATES_FINGERPRINT_OVERRIDE  optional — used when --runtime-version is absent.
 *     (One value for every platform, same as the flag, so pair it with --platform.)
 *
 * See docs/mobile-ota-updates.md ("Per-PR preview branches"). Distinct from
 * scripts/mobile-ota-health-check.ts, which asks PostHog whether shipped updates
 * BOOT; this one asks the server whether they are OFFERED.
 */

import { pathToFileURL } from 'node:url';

const LOG = '[ota-surf-doctor]';

// Every primitive of the `/branch_lists` call — the app id, the channel, the
// header set, the response interpretation — now lives in scripts/lib/ota-branch-probe.ts
// so this diagnostic and the publisher's own surfability check (scripts/mobile-publish.ts)
// ask the server exactly the same question. Re-exported because this module is the
// documented entry point for them.
import {
  DEFAULT_BASE_URL,
  OTA_APP_ID,
  OTA_CHANNEL,
  PLATFORMS,
  PROBE_TIMEOUT_MS,
  SURFING_DISABLED_HEADER,
  buildProbeHeaders,
  interpretProbe,
  probeBranchList,
  stripManifestSuffix,
  type FetchLike,
  type Platform,
  type ProbeOutcome,
  type SurfState,
  type SurfableBranch,
} from './lib/ota-branch-probe';

// Preserve the legacy exports; probeBranchList is internal to the shared helper.
export {
  DEFAULT_BASE_URL,
  OTA_APP_ID,
  OTA_CHANNEL,
  PLATFORMS,
  PROBE_TIMEOUT_MS,
  SURFING_DISABLED_HEADER,
  buildProbeHeaders,
  interpretProbe,
  stripManifestSuffix,
};
export type { FetchLike, Platform, ProbeOutcome, SurfState, SurfableBranch };

/**
 * Stand-in runtimeVersion for a probe with none supplied.
 *
 * The two questions this script answers do not need the same input. Whether the
 * CHANNEL will surf at all is a property of the channel: the server answers 404 +
 * `xprem-branch-surfing` regardless of which runtimeVersion asked. Which BRANCHES
 * are offered is filtered by runtimeVersion and platform, so it needs a real one.
 *
 * So a no-flag run still answers the first question honestly and declines the
 * second, rather than resolving a fingerprint locally and quietly answering both
 * wrong. A local resolve is untrustworthy twice over: @expo/fingerprint is not
 * deterministic across macOS and Linux (binaries bake the Linux hash), and
 * app.config.ts falls back to the EAS updates config unless EXPO_UPDATES_URL and
 * the native-build env are set, which perturbs the hash again.
 */
export const SWITCH_PROBE_RUNTIME_VERSION = 'boardsesh-surf-doctor-switch-probe';

/**
 * Where a probed runtimeVersion came from. `none` means nobody supplied one, so
 * only the switch verdict is meaningful — see SWITCH_PROBE_RUNTIME_VERSION.
 */
export type RuntimeVersionSource = 'flag' | 'env' | 'none';

export interface PlatformReport extends ProbeOutcome {
  platform: Platform;
  runtimeVersion: string;
  runtimeVersionSource: RuntimeVersionSource;
}

/**
 * Just the env this script reads. Deliberately NOT NodeJS.ProcessEnv: that type
 * requires NODE_ENV, so every test would have to invent one to pass a stub.
 */
export type DoctorEnv = Record<string, string | undefined>;

export interface DoctorArgs {
  baseUrl: string;
  platforms: Platform[];
  runtimeVersion: string | null;
  json: boolean;
}

function readFlag(argv: string[], name: string): string | null {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === `--${name}`) return argv[index + 1] ?? null;
    if (argv[index].startsWith(`--${name}=`)) return argv[index].slice(name.length + 3);
  }
  return null;
}

/** PURE: command line + env → resolved arguments. */
export function parseDoctorArgs(argv: string[], env: DoctorEnv = process.env): DoctorArgs {
  const args = argv.filter((entry) => entry !== '--');
  const configuredUrl = readFlag(args, 'base-url') ?? env.OTA_BASE_URL ?? env.EXPO_UPDATES_URL ?? DEFAULT_BASE_URL;
  const requestedPlatform = readFlag(args, 'platform');
  const platforms = requestedPlatform ? PLATFORMS.filter((platform) => platform === requestedPlatform) : [...PLATFORMS];
  if (requestedPlatform && platforms.length === 0) {
    throw new Error(`Unknown --platform "${requestedPlatform}" (expected ${PLATFORMS.join(' or ')}).`);
  }
  return {
    baseUrl: stripManifestSuffix(configuredUrl),
    platforms,
    runtimeVersion: readFlag(args, 'runtime-version') ?? null,
    json: args.includes('--json'),
  };
}

/** PURE: any platform refusing to surf, or unreachable, is the failure. */
export function doctorExitCode(reports: PlatformReport[]): number {
  return reports.some((report) => report.state === 'surfing-off' || report.state === 'unreachable') ? 1 : 0;
}

/**
 * PURE: true when ONE fingerprint was applied to several platforms.
 *
 * iOS and Android resolve to DIFFERENT fingerprints — GOOGLE_MAPS_API_KEY is an
 * Android-only input, so the publish workflows resolve them per platform. Probing
 * both with one hash makes at least one of them answer "no branches" for a reason
 * that has nothing to do with the server, which is exactly the false alarm this
 * script exists to prevent.
 *
 * Keyed on what was actually probed, not on the flag: `--runtime-version` and
 * EXPO_UPDATES_FINGERPRINT_OVERRIDE both supply one string for every platform. A
 * `none` probe is excluded because its branch list is never interpreted anyway.
 */
export function warnsAboutSharedRuntimeVersion(reports: PlatformReport[]): boolean {
  const supplied = reports.filter((report) => report.runtimeVersionSource !== 'none');
  return supplied.length > 1 && new Set(supplied.map((report) => report.runtimeVersion)).size === 1;
}

/** PURE: the report a human reads. */
export function summarizeReports(reports: PlatformReport[], baseUrl: string): string[] {
  const lines = [`${LOG} server: ${baseUrl}  app: ${OTA_APP_ID}  channel: ${OTA_CHANNEL}`];
  for (const report of reports) {
    lines.push('');
    const switchOnly = report.runtimeVersionSource === 'none';
    lines.push(
      switchOnly
        ? `${LOG} ── ${report.platform} ─ switch check only (no runtimeVersion supplied)`
        : `${LOG} ── ${report.platform} ─ runtimeVersion ${report.runtimeVersion} (${report.runtimeVersionSource})`,
    );
    lines.push(`${LOG}    ${report.detail}`);
    if (report.state === 'surfing-off') {
      lines.push(`${LOG}    Branch surfing is OFF for "${OTA_CHANNEL}". Testers see "Previews are switched off".`);
      lines.push(`${LOG}    Fix: dashboard → Channels → select "${OTA_CHANNEL}" → Branch surfing → on, pattern pr-*`);
    }
    if (report.state === 'no-branches' && switchOnly) {
      // The list came back filtered by a sentinel runtimeVersion, so it is empty by
      // construction and says nothing. Claiming otherwise would be the exact false
      // alarm this script exists to prevent.
      lines.push(`${LOG}    Surfing is ON for "${OTA_CHANNEL}". Branch list NOT checked.`);
      lines.push(`${LOG}    Branches are filtered by exact runtimeVersion + platform, so pass`);
      lines.push(`${LOG}    --runtime-version <hash> --platform <ios|android> to see what a build is offered.`);
      lines.push(`${LOG}    Take <hash> from a native build's EXPO_UPDATES_FINGERPRINT_OVERRIDE.`);
    } else if (report.state === 'no-branches') {
      lines.push(`${LOG}    Surfing is ON, but no branch matches this runtimeVersion + platform.`);
      lines.push(`${LOG}    Either no PR has published a preview, or every pr-* branch predates the latest`);
      lines.push(`${LOG}    native change on main. A PR behind that change must rebase to republish.`);
    }
    for (const branch of report.branches) {
      lines.push(`${LOG}    • ${branch.name}${branch.lastUpdateAt ? `  (updated ${branch.lastUpdateAt})` : ''}`);
    }
  }
  return lines;
}

/**
 * PURE: which runtimeVersion to probe with, and how much it can be trusted.
 * Falls back to the sentinel rather than resolving one locally — see
 * SWITCH_PROBE_RUNTIME_VERSION for why a local resolve cannot be trusted.
 */
export function resolveProbeRuntimeVersion(
  args: DoctorArgs,
  env: DoctorEnv,
): { runtimeVersion: string; source: RuntimeVersionSource } {
  if (args.runtimeVersion) return { runtimeVersion: args.runtimeVersion, source: 'flag' };
  const fromEnv = env.EXPO_UPDATES_FINGERPRINT_OVERRIDE?.trim();
  if (fromEnv) return { runtimeVersion: fromEnv, source: 'env' };
  return { runtimeVersion: SWITCH_PROBE_RUNTIME_VERSION, source: 'none' };
}

export async function runSurfDoctor(
  args: DoctorArgs,
  fetchImpl: FetchLike = fetch,
  env: DoctorEnv = process.env,
): Promise<number> {
  const { runtimeVersion, source } = resolveProbeRuntimeVersion(args, env);
  const reports: PlatformReport[] = [];
  for (const platform of args.platforms) {
    const outcome = await probeBranchList(fetchImpl, args.baseUrl, runtimeVersion, platform);
    reports.push({ platform, runtimeVersion, runtimeVersionSource: source, ...outcome });
  }

  if (args.json) {
    console.log(JSON.stringify({ baseUrl: args.baseUrl, appId: OTA_APP_ID, channel: OTA_CHANNEL, reports }, null, 2));
  } else {
    console.log(summarizeReports(reports, args.baseUrl).join('\n'));
    if (warnsAboutSharedRuntimeVersion(reports)) {
      console.log('');
      console.log(
        `${LOG} NOTE: one fingerprint was applied to ${reports.map((report) => report.platform).join(' and ')},`,
      );
      console.log(`${LOG} but iOS and Android resolve to different ones. Add --platform to probe one honestly.`);
    }
  }
  return doctorExitCode(reports);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSurfDoctor(parseDoctorArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
