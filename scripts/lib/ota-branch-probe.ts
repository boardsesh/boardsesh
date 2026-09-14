/// <reference types="node" />

/**
 * Asks the self-hosted xprem update server the question a device asks: which
 * `pr-<n>` branches will you serve to THIS runtimeVersion and platform?
 *
 * `GET /branch_lists` is an unauthenticated DEVICE endpoint, so this needs no
 * credentials — which is what makes it usable from two very different callers:
 *
 *   * scripts/mobile-ota-surf-doctor.ts — the human diagnostic ("why is the
 *     picker empty?"), run from a laptop;
 *   * scripts/mobile-publish.ts — the publisher's own check that what it just
 *     uploaded is actually being offered, run in CI.
 *
 * They share this module so the two can never disagree about what "surfable"
 * means. Everything here is dependency-free and `fetch` is injectable, so both
 * the pure interpretation and the request path are unit-testable.
 *
 * See docs/mobile-ota-updates.md ("Per-PR preview branches").
 */

// The app id the V3 server routes on (the `expo-app-id` header the client sends).
// Kept as a literal per file rather than shared with packages/mobile: that copy is
// read by Expo's config loader, which cannot resolve a sibling .ts, and
// scripts/ota-preview-cleanup.ts runs under bare `node --experimental-strip-types`
// with no install step. All copies are pinned equal by
// scripts/mobile-ci-env-parity.test.ts.
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

/**
 * Narrower than `typeof fetch` on purpose: it describes exactly what
 * `probeBranchList` passes, so a stub in a test is a two-field object rather than
 * the whole `RequestInit` surface. The global `fetch` is still assignable.
 */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

/**
 * Cap on one probe. Both callers need an unreachable server to come back as a
 * REPORT rather than a hang: for the doctor a hang looks like a fourth, unnamed
 * failure state, and for the publisher it would park a CI job behind an OS-level
 * TCP timeout after the upload has already succeeded.
 */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * How long a caller should keep asking before believing a branch is absent, in
 * wait order.
 *
 * The server does not reflect a freshly finished publish instantly — the preview
 * workflow's own PR comment has told testers "the server may take up to 15 seconds
 * to refresh the branch list after publishing" since the feature shipped. A single
 * probe fired the moment `eoas` returns would therefore fail good publishes, which
 * is worse than the bug the check exists to catch: a red X on a working preview
 * teaches people to ignore the check.
 *
 * ~31s in total, comfortably past that 15s, and it costs nothing on the ordinary
 * path — a branch that is listed is listed on the first probe and nothing sleeps.
 * scripts/lib/mobile-publish-retry.ts folds this into the publish job's derived
 * `timeout-minutes` floor, so lengthening it here cannot silently outgrow the job.
 */
export const SURFABILITY_PROBE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/**
 * Worst case for one full round of probing, in minutes: every sleep, PLUS every
 * request sitting out its own `PROBE_TIMEOUT_MS` cap. Counting only the sleeps
 * would understate it by the larger half — six capped requests are 90s against
 * 31s of waiting — and the publish job's timeout floor is derived from this.
 */
export const SURFABILITY_PROBE_BUDGET_MINUTES =
  (SURFABILITY_PROBE_DELAYS_MS.reduce((total, delayMs) => total + delayMs, 0) +
    (SURFABILITY_PROBE_DELAYS_MS.length + 1) * PROBE_TIMEOUT_MS) /
  60_000;

/** PURE: strip an EXPO_UPDATES_URL's trailing `/manifest` to the server base URL. */
export function stripManifestSuffix(url: string): string {
  return url.replace(/\/manifest\/?$/, '').replace(/\/+$/, '');
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

/**
 * One `/branch_lists` request, per platform, never throwing: a transport failure
 * comes back as `unreachable` with the reason in `detail`.
 */
export async function probeBranchList(
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

/**
 * PURE: the named branch as this platform would be offered it, or null.
 *
 * Null covers three different things on purpose — the branch is absent, the
 * channel refuses to surf, the server could not be reached — because every one
 * of them means the same thing to a publisher: a device asking this question
 * right now would not be offered the branch. The caller reports `outcome.detail`
 * so the three stay distinguishable in the log.
 */
export function findSurfableBranch(outcome: ProbeOutcome, branch: string): SurfableBranch | null {
  return outcome.branches.find((entry) => entry.name === branch) ?? null;
}
