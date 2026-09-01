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
 *   vp run mobile:ota-surf-doctor
 *   vp run mobile:ota-surf-doctor -- --runtime-version <hash>   # authoritative
 *   vp run mobile:ota-surf-doctor -- --platform ios --json
 *
 * Exit codes:
 *   0  surfing is on (whether or not any branch matched — an empty list is a
 *      diagnosis, not a build failure)
 *   1  surfing is off for the channel, or the server could not be reached
 *
 * Env:
 *   OTA_BASE_URL / EXPO_UPDATES_URL  optional — defaults to the production server.
 *   EXPO_UPDATES_FINGERPRINT_OVERRIDE  optional — used when --runtime-version is absent.
 *
 * See docs/mobile-ota-updates.md ("Per-PR preview branches"). Distinct from
 * scripts/mobile-ota-health-check.ts, which asks PostHog whether shipped updates
 * BOOT; this one asks the server whether they are OFFERED.
 */

import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const LOG = '[ota-surf-doctor]';

// The app id the V3 server routes on (the `expo-app-id` header the client sends).
// Kept as a literal per file rather than shared: scripts/ota-preview-cleanup.ts
// runs under bare `node --experimental-strip-types` with no install step, and
// app.config.ts is read by a loader that can't resolve a sibling .ts. All copies
// are pinned equal by scripts/mobile-ci-env-parity.test.ts.
export const OTA_APP_ID = '007e6fd7-f200-448c-9449-8d48ba5d51fc';

// The channel every production/TestFlight binary bakes into `expo-channel-name`
// (packages/mobile/app.config.ts). Branch surfing is a property OF this channel.
export const OTA_CHANNEL = 'production';

export const DEFAULT_BASE_URL = 'https://updates.boardsesh.com';

// Set by xprem on a 404 that came from branch surfing being off for the channel,
// as opposed to any other 404 on the way. Mirrors SURFING_DISABLED_HEADER in
// @xprem/control-center's surf.ts — the client keys the same distinction off it.
export const SURFING_DISABLED_HEADER = 'xprem-branch-surfing';

export const PLATFORMS = ['ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Where a probed runtimeVersion came from — reported, because it changes how much to trust it. */
export type RuntimeVersionSource = 'flag' | 'env' | 'resolved';

export type SurfState = 'surfing-off' | 'branches' | 'no-branches' | 'unreachable';

export interface SurfableBranch {
  name: string;
  lastUpdateAt?: string;
}

export interface ProbeOutcome {
  state: SurfState;
  branches: SurfableBranch[];
  total: number;
  /** Human-readable "why" — the status line, or the parse failure. */
  detail: string;
}

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

/** PURE: strip an EXPO_UPDATES_URL's trailing `/manifest` to the server base URL. */
export function stripManifestSuffix(url: string): string {
  return url.replace(/\/manifest\/?$/, '').replace(/\/+$/, '');
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

/**
 * PURE: the exact header set a binary sends. app.config.ts bakes `expo-app-id`,
 * `expo-channel-name` and `xprem-branch`; expo-updates adds the runtime version
 * and platform. `xprem-branch` is deliberately absent here — an empty branch
 * header is what "I am on the channel's own branch" looks like, and that is the
 * state we want to probe from.
 */
export function buildProbeHeaders(runtimeVersion: string, platform: Platform): Record<string, string> {
  return {
    'expo-app-id': OTA_APP_ID,
    'expo-channel-name': OTA_CHANNEL,
    'expo-runtime-version': runtimeVersion,
    'expo-platform': platform,
  };
}

/**
 * PURE: an HTTP answer → one of the three states the app renders, plus
 * "unreachable" for everything that is neither.
 *
 * The 404 split is the whole point: a 404 CARRYING the surfing header means the
 * channel refuses to surf, while a bare 404 means something else answered — a
 * proxy, a wrong base URL, a retired server. The app conflates neither, so
 * neither does this.
 */
export function interpretProbe(status: number, headers: Headers, body: unknown): ProbeOutcome {
  if (status === 404) {
    return headers.get(SURFING_DISABLED_HEADER) !== null
      ? { state: 'surfing-off', branches: [], total: 0, detail: `HTTP 404, ${SURFING_DISABLED_HEADER}: off` }
      : {
          state: 'unreachable',
          branches: [],
          total: 0,
          detail: `HTTP 404 without a ${SURFING_DISABLED_HEADER} header — is the base URL right?`,
        };
  }
  if (status !== 200) {
    return { state: 'unreachable', branches: [], total: 0, detail: `HTTP ${status}` };
  }
  const payload = body as { branches?: unknown; total?: unknown } | null;
  if (!payload || !Array.isArray(payload.branches)) {
    return { state: 'unreachable', branches: [], total: 0, detail: 'HTTP 200 with an unexpected body shape' };
  }
  const branches = payload.branches
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      name: String(entry.name ?? ''),
      lastUpdateAt: typeof entry.lastUpdateAt === 'string' ? entry.lastUpdateAt : undefined,
    }))
    .filter((entry) => entry.name.length > 0);
  const total = typeof payload.total === 'number' ? payload.total : branches.length;
  return {
    state: branches.length > 0 ? 'branches' : 'no-branches',
    branches,
    total,
    detail: `HTTP 200, ${total} branch${total === 1 ? '' : 'es'}`,
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
 * EXPO_UPDATES_FINGERPRINT_OVERRIDE both supply one string for every platform, and
 * only the locally resolved path is per-platform by construction.
 */
export function warnsAboutSharedRuntimeVersion(reports: PlatformReport[]): boolean {
  const supplied = reports.filter((report) => report.runtimeVersionSource !== 'resolved');
  return supplied.length > 1 && new Set(supplied.map((report) => report.runtimeVersion)).size === 1;
}

/** PURE: the report a human reads. */
export function summarizeReports(reports: PlatformReport[], baseUrl: string): string[] {
  const lines = [`${LOG} server: ${baseUrl}  app: ${OTA_APP_ID}  channel: ${OTA_CHANNEL}`];
  for (const report of reports) {
    lines.push('');
    lines.push(
      `${LOG} ── ${report.platform} ─ runtimeVersion ${report.runtimeVersion} (${report.runtimeVersionSource})`,
    );
    lines.push(`${LOG}    ${report.detail}`);
    if (report.state === 'surfing-off') {
      lines.push(`${LOG}    Branch surfing is OFF for "${OTA_CHANNEL}". Testers see "Previews are switched off".`);
      lines.push(`${LOG}    Fix: dashboard → Channels → select "${OTA_CHANNEL}" → Branch surfing → on, pattern pr-*`);
    }
    if (report.state === 'no-branches') {
      lines.push(`${LOG}    Surfing is ON, but no branch matches this runtimeVersion + platform.`);
      lines.push(`${LOG}    Either no PR has published a preview, or every pr-* branch predates the latest`);
      lines.push(`${LOG}    native change on main. A PR behind that change must rebase to republish.`);
    }
    for (const branch of report.branches) {
      lines.push(`${LOG}    • ${branch.name}${branch.lastUpdateAt ? `  (updated ${branch.lastUpdateAt})` : ''}`);
    }
    if (report.runtimeVersionSource === 'resolved') {
      lines.push(`${LOG}    NOTE: this fingerprint was resolved locally. @expo/fingerprint is not`);
      lines.push(`${LOG}    deterministic across macOS and Linux, and binaries bake the LINUX one — so an`);
      lines.push(`${LOG}    empty list here may be a false alarm. Pass --runtime-version with the value from`);
      lines.push(`${LOG}    a native build's EXPO_UPDATES_FINGERPRINT_OVERRIDE for a trustworthy answer.`);
    }
  }
  return lines;
}

/** Resolve this checkout's fingerprint for a platform. Returns null when it can't. */
function resolveLocalRuntimeVersion(platform: Platform): string | null {
  const result = spawnSync('vp', ['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', platform], {
    cwd: new URL('../packages/mobile/', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.match(/\b([0-9a-f]{40})\b/)?.[1] ?? null;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

/**
 * Cap on one probe. This is a diagnostic someone reaches for when previews look
 * broken, so an unreachable server has to come back as a REPORT ("unreachable")
 * rather than a hang — a script that never returns looks like a fourth, unnamed
 * failure state.
 */
export const PROBE_TIMEOUT_MS = 15_000;

async function probePlatform(
  fetchImpl: FetchLike,
  baseUrl: string,
  runtimeVersion: string,
  platform: Platform,
): Promise<ProbeOutcome> {
  try {
    // ?all=1 raises the page cap only; it does NOT bypass the runtimeVersion or
    // platform filter, so a wrong fingerprint still reads as an empty list.
    const response = await fetchImpl(`${baseUrl}/branch_lists?all=1`, {
      headers: buildProbeHeaders(runtimeVersion, platform),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = response.status === 200 ? await response.json().catch(() => null) : null;
    return interpretProbe(response.status, response.headers, body);
  } catch (error) {
    return {
      state: 'unreachable',
      branches: [],
      total: 0,
      detail: `request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function runSurfDoctor(
  args: DoctorArgs,
  fetchImpl: FetchLike = fetch,
  env: DoctorEnv = process.env,
): Promise<number> {
  const reports: PlatformReport[] = [];
  for (const platform of args.platforms) {
    let runtimeVersion = args.runtimeVersion;
    let source: RuntimeVersionSource = 'flag';
    if (!runtimeVersion) {
      const fromEnv = env.EXPO_UPDATES_FINGERPRINT_OVERRIDE?.trim();
      if (fromEnv) {
        runtimeVersion = fromEnv;
        source = 'env';
      } else {
        runtimeVersion = resolveLocalRuntimeVersion(platform);
        source = 'resolved';
      }
    }
    if (!runtimeVersion) {
      console.error(
        `${LOG} Could not resolve a runtimeVersion for ${platform}. Pass --runtime-version <hash> (take it from a native build's EXPO_UPDATES_FINGERPRINT_OVERRIDE).`,
      );
      return 1;
    }
    const outcome = await probePlatform(fetchImpl, args.baseUrl, runtimeVersion, platform);
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
