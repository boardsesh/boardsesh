/// <reference types="node" />

/**
 * The decisions behind `scripts/mobile-ota-boot-check.ts`, with no I/O.
 *
 * The boot check installs a release build on a simulator or emulator, pins it
 * to an update branch the way a phone is pinned, launches it twice and reads
 * what expo-updates wrote down. Three questions are answered here:
 *
 *   1. Which update must the branch be serving for the commit under test?
 *      (`expectationFromReceipt`, `resolveExpectedUpdate`)
 *   2. Is this binary one a phone could hold, and how is it pinned to a
 *      branch? (`checkBinary`, `pinAndroidManifest`)
 *   3. Did the second launch run that update and draw its first screen?
 *      (`judgeBoot`)
 *
 * See docs/mobile-ota-updates.md ("Boot check").
 */

export const BOOT_PLATFORMS = ['ios', 'android'] as const;
export type BootPlatform = (typeof BOOT_PLATFORMS)[number];

export const APP_BUNDLE_ID = 'com.boardsesh.app';
export const OTA_APP_ID = '007e6fd7-f200-448c-9449-8d48ba5d51fc';

/** adbd may close the requesting transport while switching to root. Only UID0 proves the reconnect succeeded. */
export function ensureAndroidRoot(
  adb: (args: readonly string[], timeoutMs: number) => string,
  nowMs: () => number = Date.now,
): void {
  const deadline = nowMs() + 30_000;
  const remainingMs = () => {
    const remaining = deadline - nowMs();
    if (remaining <= 0) throw new Error('adb root handshake exceeded 30 seconds.');
    return remaining;
  };
  const transportRestart = (error: unknown) =>
    error instanceof Error &&
    /unable to connect for root: closed|device offline|device not found|connection reset|transport.*closed/i.test(
      error.message,
    );
  let lastUid = 'unconfirmed';
  for (let attempt = 0; attempt < 3; attempt++) {
    let restarting = false;
    try {
      const output = adb(['root'], remainingMs());
      if (/adbd cannot run as root|root access is disabled/i.test(output))
        throw new Error('The emulator refuses adb root; private app evidence requires UID0.');
      restarting = /restarting adbd as root/i.test(output);
    } catch (error) {
      if (!transportRestart(error)) throw error;
      restarting = true;
    }
    try {
      adb(['wait-for-device'], remainingMs());
      lastUid = adb(['shell', 'id', '-u'], remainingMs()).trim();
      if (lastUid === '0') return;
      if (!restarting) throw new Error(`adb root is unverified (UID ${lastUid}); private app evidence requires UID0.`);
    } catch (error) {
      if (!transportRestart(error)) throw error;
    }
  }
  throw new Error(
    `adb root could not be verified after 3 attempts (UID ${lastUid}); private app evidence requires UID0.`,
  );
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const RUNTIME_VERSION = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UPDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BRANCH_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * One device id per platform, reused by every run. xprem registers a device in
 * Observe when `EAS-Client-ID` parses as a UUID, and a fresh install mints a new
 * one, so an unseeded daily gate would add two devices a day to a registry the
 * real fleet fills with about 450. Seeded, the gate is the same two devices for
 * ever. expo-eas-client parses the stored value as a UUID, so it has to be one.
 */
export const BOOT_CHECK_CLIENT_IDS: Record<BootPlatform, string> = {
  ios: 'b007c4ec-0000-4000-8000-000000000105',
  android: 'b007c4ec-0000-4000-8000-0000000a11d0',
};

/**
 * Hosts the update under test reports to. The published bytes carry the
 * production PostHog key and Sentry DSN, and nothing about a simulator makes
 * them stay quiet, so the check requires these names to resolve to nowhere on
 * the device before it launches anything.
 */
export const TELEMETRY_HOSTS = [
  'us.i.posthog.com',
  'us-assets.i.posthog.com',
  'o4510644927660032.ingest.us.sentry.io',
] as const;

/** The address a sinkholed name resolves to. A connection to it is refused at once. */
export const SINKHOLE_ADDRESS = '0.0.0.0';

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function text(input: unknown, label: string): string {
  if (typeof input !== 'string' || input === '') throw new Error(`${label} must be a non-empty string.`);
  return input;
}

export function assertBranchName(branch: string): string {
  if (!BRANCH_NAME.test(branch)) throw new Error(`Branch name is not valid: ${JSON.stringify(branch)}.`);
  return branch;
}

/** Treat adb output as a component name, never as executable shell text. */
export function androidLaunchCommand(resolved: string): string {
  const activity = resolved.trim().split('\n').at(-1)?.trim() ?? '';
  const [packageName, className, extra] = activity.split('/');
  if (
    packageName !== APP_BUNDLE_ID ||
    extra !== undefined ||
    className === undefined ||
    !/^\.?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(className)
  ) {
    throw new Error(`No valid launcher activity found: ${resolved}`);
  }
  // A dollar sign is valid in nested Java class names: quote even validated names.
  return `am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n '${activity}'`;
}

// ---------------------------------------------------------------------------
// 1. Which update is under test
// ---------------------------------------------------------------------------

/**
 * What the branch must serve. A stage receipt names the bundle by its bytes
 * (`bundleSha256`); a hand-written receipt may name the update by its id.
 */
export interface BootExpectation {
  commit: string;
  runtimeVersion: string;
  bundleSha256: string | null;
  updateId: string | null;
}

/**
 * Reads one platform's expectation out of a receipt and refuses a receipt for
 * another commit. The receipt is the `receipt.json` the stage job archives
 * beside the export it published (`mobile-ota-production.yml`), or the same
 * shape written by hand with an `updateId` per platform.
 */
export function expectationFromReceipt(
  receiptInput: unknown,
  platform: BootPlatform,
  expectCommit: string,
): BootExpectation {
  const commit = expectCommit.toLowerCase();
  if (!COMMIT_SHA.test(commit)) throw new Error('--expect-commit must be a 40-character commit SHA.');
  const receipt = record(receiptInput, 'Receipt');
  const receiptCommit = text(receipt.commitHash, 'Receipt commitHash').toLowerCase();
  if (receiptCommit !== commit) {
    throw new Error(`The receipt is for commit ${receiptCommit}, not the commit under test ${commit}.`);
  }
  const entry = record(record(receipt.platforms, 'Receipt platforms')[platform], `Receipt ${platform} entry`);
  const runtimeVersion = text(entry.runtimeVersion, `Receipt ${platform} runtimeVersion`).toLowerCase();
  if (!RUNTIME_VERSION.test(runtimeVersion)) {
    throw new Error(`Receipt ${platform} runtimeVersion is not a 40-character fingerprint.`);
  }
  const bundleSha256 = entry.bundleSha256 === undefined ? null : text(entry.bundleSha256, 'bundleSha256').toLowerCase();
  const updateId = entry.updateId === undefined ? null : text(entry.updateId, 'updateId').toLowerCase();
  if (bundleSha256 !== null && !SHA256_HEX.test(bundleSha256)) {
    throw new Error(`Receipt ${platform} bundleSha256 is not a SHA-256 hex digest.`);
  }
  if (updateId !== null && !UPDATE_ID.test(updateId)) {
    throw new Error(`Receipt ${platform} updateId is not a UUID-shaped update id.`);
  }
  if (bundleSha256 === null && updateId === null) {
    throw new Error(
      `Receipt ${platform} entry names neither a bundleSha256 nor an updateId, so nothing ties it to a commit.`,
    );
  }
  return { commit, runtimeVersion, bundleSha256, updateId };
}

/** The fields of a served manifest the check reads. */
export interface ServedHead {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  /** `extra.branch`: the branch the server answered from, which is not always the one asked for. */
  branch: string | null;
  /** `launchAsset.hash`: base64url SHA-256 of the bundle. */
  launchAssetHash: string;
  assetCount: number;
}

export function readServedHead(manifestInput: unknown): ServedHead {
  const manifest = record(manifestInput, 'Manifest');
  const extra = manifest.extra === undefined ? {} : record(manifest.extra, 'Manifest extra');
  const launchAsset = record(manifest.launchAsset, 'Manifest launchAsset');
  return {
    id: text(manifest.id, 'Manifest id').toLowerCase(),
    createdAt: text(manifest.createdAt, 'Manifest createdAt'),
    runtimeVersion: text(manifest.runtimeVersion, 'Manifest runtimeVersion').toLowerCase(),
    branch: typeof extra.branch === 'string' ? extra.branch : null,
    launchAssetHash: text(launchAsset.hash, 'Manifest launchAsset hash'),
    assetCount: Array.isArray(manifest.assets) ? manifest.assets.length : 0,
  };
}

/** A hex SHA-256 in the base64url form a manifest carries. */
export function sha256HexToBase64Url(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64url');
}

export type ExpectedUpdate = { ok: true; updateId: string; head: ServedHead } | { ok: false; reason: string };

/**
 * Ties the branch head to the commit under test, or says why it cannot.
 *
 * Every refusal here is a failed check, never a skipped one: when the branch is
 * serving something else, launching it would prove that something else boots.
 */
export function resolveExpectedUpdate(
  expectation: BootExpectation,
  served: ServedHead | null,
  branch: string,
): ExpectedUpdate {
  if (served === null) {
    return {
      ok: false,
      reason: `The server has no update at all for runtime ${expectation.runtimeVersion} on ${branch}.`,
    };
  }
  if (served.branch !== branch) {
    return {
      ok: false,
      reason:
        `Asked for ${branch}, answered from ${served.branch ?? 'an unnamed branch'}: ${branch} has no update for runtime ` +
        `${expectation.runtimeVersion}, or Branch Surfing does not offer it, so the server fell back.`,
    };
  }
  if (served.runtimeVersion !== expectation.runtimeVersion) {
    return {
      ok: false,
      reason: `${branch} answered with runtime ${served.runtimeVersion}, not ${expectation.runtimeVersion}.`,
    };
  }
  if (expectation.updateId !== null && served.id !== expectation.updateId) {
    return {
      ok: false,
      reason:
        `The head of ${branch} is update ${served.id} (created ${served.createdAt}), not ${expectation.updateId}, ` +
        `the update named for commit ${expectation.commit}.`,
    };
  }
  if (expectation.bundleSha256 !== null && served.launchAssetHash !== sha256HexToBase64Url(expectation.bundleSha256)) {
    return {
      ok: false,
      reason:
        `The head of ${branch} is update ${served.id} (created ${served.createdAt}), and its bundle is not the one ` +
        `staged for commit ${expectation.commit}. The branch has moved on, or that commit was never published to it.`,
    };
  }
  return { ok: true, updateId: served.id, head: served };
}

// ---------------------------------------------------------------------------
// 2. The binary
// ---------------------------------------------------------------------------

/** expo-eas-client keeps its device id under this `UserDefaults` key (`EASClientID.swift`). */
export const IOS_EAS_CLIENT_ID_KEY = 'expo.eas-client-id';

/** On Android it is a SharedPreferences file (`EASClientID.kt`). */
export const ANDROID_EAS_PREFS_FILE = 'dev.expo.EASSharedPreferences.xml';

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function androidEasClientPrefsXml(clientId: string): string {
  return (
    `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n` +
    `<map>\n    <string name="eas-client-id">${xmlEscape(clientId)}</string>\n</map>\n`
  );
}

/**
 * The empty branch header exactly as `expo prebuild` writes it into the
 * generated AndroidManifest.xml, inside the request-headers meta-data value.
 */
const ANDROID_UNPINNED_BRANCH = '&quot;xprem-branch&quot;:&quot;&quot;';

/**
 * Pins a GENERATED Android project to `branch` by rewriting the one header in
 * its manifest. An APK's manifest is compiled, so unlike the iOS plist it cannot
 * be edited after the build; the edit happens between prebuild and Gradle, in
 * the generated `android/` folder that is never committed.
 *
 * The branch has to be baked, on both platforms. expo-updates can also take the
 * header from a stored override, which is how a phone is pinned, but the app
 * clears that override on a fresh install's first launch
 * (`OtaBranchSurfingInitializer` in packages/mobile/app/_layout.tsx).
 */
export function pinAndroidManifest(manifestXml: string, branch: string): string {
  const occurrences = manifestXml.split(ANDROID_UNPINNED_BRANCH).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Expected the generated AndroidManifest.xml to carry one empty xprem-branch header, found ${occurrences}.`,
    );
  }
  return manifestXml.replace(
    ANDROID_UNPINNED_BRANCH,
    `&quot;xprem-branch&quot;:&quot;${assertBranchName(branch)}&quot;`,
  );
}

/** What the check can read out of a built binary before installing it. */
export interface BinaryDescription {
  /** The baked runtime version, or null where the binary's format hides it (a compiled Android manifest). */
  runtimeVersion: string | null;
  /** `id` of the bundle built into the binary, from its `app.manifest`. */
  embeddedUpdateId: string;
  /** `commitTime` of the bundle built into the binary, in milliseconds. */
  embeddedCommitTimeMs: number;
  /** Present when fixture preparation preserved the original embedded timestamp. */
  originalEmbeddedCommitTimeMs?: number;
}

/** A release fixture represents an already-installed binary, before any candidate publication. */
export const BOOT_FIXTURE_COMMIT_TIME_MS = 946_684_800_000;

/** Changes only the generated embedded manifest's ordering timestamp, never its identity or assets. */
export function stampEmbeddedFixtureManifest(manifestJson: string): string {
  const manifest = record(JSON.parse(manifestJson) as unknown, 'Embedded fixture app.manifest');
  const embedded = readEmbeddedManifest(manifestJson);
  if (!UPDATE_ID.test(embedded.embeddedUpdateId))
    throw new Error('The embedded fixture app.manifest has no valid UUID.');
  if (!Array.isArray(manifest.assets)) throw new Error('The embedded fixture app.manifest has no assets array.');
  return `${JSON.stringify({ ...manifest, commitTime: BOOT_FIXTURE_COMMIT_TIME_MS })}\n`;
}

export function requireEmbeddedFixture(manifestJson: string): void {
  if (readEmbeddedManifest(manifestJson).embeddedCommitTimeMs !== BOOT_FIXTURE_COMMIT_TIME_MS)
    throw new Error('The prepared binary does not carry the historical boot fixture timestamp.');
}

/** Reads the embedded bundle's identity out of the `app.manifest` a release build carries. */
export function readEmbeddedManifest(manifestJson: string): { embeddedUpdateId: string; embeddedCommitTimeMs: number } {
  const manifest = record(JSON.parse(manifestJson) as unknown, 'Embedded app.manifest');
  if (typeof manifest.commitTime !== 'number' || !Number.isSafeInteger(manifest.commitTime) || manifest.commitTime <= 0)
    throw new Error('The embedded app.manifest has no valid commitTime.');
  return {
    embeddedUpdateId: text(manifest.id, 'Embedded app.manifest id').toLowerCase(),
    embeddedCommitTimeMs: manifest.commitTime,
  };
}

/**
 * Says why a binary cannot stand in for a phone that is offered this update,
 * or returns null when it can.
 *
 * expo-updates only downloads an update that is newer than the one running, by
 * `commitTime`. Stock Expo stamps build time; Boardsesh's production patch
 * uses the Git committer date. Either may outrank a content-deduplicated update.
 * A prepared boot fixture uses a fixed historical timestamp instead, but this
 * check still refuses any candidate that is not strictly newer than its binary.
 */
export function checkBinary(binary: BinaryDescription, expectation: BootExpectation, head: ServedHead): string | null {
  if (binary.runtimeVersion !== null && binary.runtimeVersion !== expectation.runtimeVersion) {
    return (
      `The binary bakes runtime version ${binary.runtimeVersion} and the update is for ${expectation.runtimeVersion}. ` +
      `Build it with EXPO_UPDATES_FINGERPRINT_OVERRIDE set to the update's runtime version.`
    );
  }
  const publishedAtMs = Date.parse(head.createdAt);
  if (!Number.isFinite(publishedAtMs)) return `The update's createdAt is not a date: ${head.createdAt}.`;
  if (binary.embeddedCommitTimeMs >= publishedAtMs) {
    return (
      `The binary's embedded bundle is dated ${new Date(binary.embeddedCommitTimeMs).toISOString()}, which is not before ` +
      `the update was published (${head.createdAt}). expo-updates would not download it. Build the binary from the ` +
      `commit under test, or from an earlier commit with the same native inputs.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Reading what the launches left behind
// ---------------------------------------------------------------------------

/**
 * The query run against the expo-updates database copied off the device. The
 * table has the same columns on iOS (`expo-v11.db`) and Android (`updates.db`).
 */
export const UPDATES_QUERY =
  'SELECT lower(hex(id)) AS id, status, commit_time, last_accessed, runtime_version, ' +
  'successful_launch_count, failed_launch_count, headers FROM updates ORDER BY commit_time, id;';

/** One row of expo-updates' `updates` table. */
export interface UpdateRow {
  id: string;
  /**
   * Every asset is on disk, so the update can be launched. The embedded bundle
   * is ready on Android and has a status of its own on iOS.
   */
  ready: boolean;
  commitTime: number;
  lastAccessed: number;
  runtimeVersion: string;
  successfulLaunchCount: number;
  failedLaunchCount: number;
  /** The request headers the update was stamped with, or null when the column is empty. */
  headers: Record<string, string> | null;
}

/** `UpdateStatus` has the same raw values on iOS (`Update.swift`) and Android (`Converters.kt`). */
const STATUS_READY = 1;

function hexToUuid(hex: string): string {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Update id is not 16 bytes of hex: ${JSON.stringify(hex)}.`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function count(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) throw new Error(`${label} must be a number.`);
  return input;
}

function stampedHeaders(input: unknown): Record<string, string> | null {
  if (typeof input !== 'string' || input === '') return null;
  const parsed = record(JSON.parse(input) as unknown, 'Update headers');
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
}

/** Parses `sqlite3 -json` output for `UPDATES_QUERY`. An empty table prints nothing. */
export function parseUpdateRows(sqliteJson: string): UpdateRow[] {
  if (sqliteJson.trim() === '') return [];
  const rows: unknown = JSON.parse(sqliteJson);
  if (!Array.isArray(rows)) throw new Error('The updates query did not return a list of rows.');
  return rows.map((rowInput: unknown) => {
    const row = record(rowInput, 'Update row');
    return {
      id: hexToUuid(text(row.id, 'Update row id')),
      ready: count(row.status, 'Update row status') === STATUS_READY,
      commitTime: count(row.commit_time, 'Update row commit_time'),
      lastAccessed: count(row.last_accessed, 'Update row last_accessed'),
      runtimeVersion: text(row.runtime_version, 'Update row runtime_version'),
      successfulLaunchCount: count(row.successful_launch_count, 'Update row successful_launch_count'),
      failedLaunchCount: count(row.failed_launch_count, 'Update row failed_launch_count'),
      headers: stampedHeaders(row.headers),
    };
  });
}

/** One line of expo-updates' own log file (`UpdatesLogEntry`). */
export interface UpdatesLogLine {
  timestamp: number;
  level: string;
  code: string;
  message: string;
  updateId: string | null;
}

/** Parses the persistent expo-updates log. Lines that are not log entries are dropped. */
export function parseUpdatesLog(contents: string): UpdatesLogLine[] {
  const lines: UpdatesLogLine[] = [];
  for (const line of contents.split(/\r?\n/)) {
    // Each line is a level marker (an emoji), a space, then the JSON entry.
    const start = line.indexOf('{');
    if (start === -1) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = record(JSON.parse(line.slice(start)) as unknown, 'Log line');
    } catch {
      continue;
    }
    if (typeof parsed.timestamp !== 'number' || typeof parsed.message !== 'string') continue;
    lines.push({
      timestamp: parsed.timestamp,
      level: typeof parsed.level === 'string' ? parsed.level : 'info',
      code: typeof parsed.code === 'string' ? parsed.code : 'None',
      message: parsed.message,
      updateId: typeof parsed.updateId === 'string' ? parsed.updateId.toLowerCase() : null,
    });
  }
  return lines;
}

/**
 * Device-log lines that mean the process died or its JS threw past every
 * handler. Kept narrow on purpose: a release app logs plenty of recoverable
 * errors, and a gate that fails on any of them gets switched off.
 */
const FATAL_LOG_PATTERNS: Record<BootPlatform, readonly RegExp[]> = {
  ios: [
    /EXC_BAD_ACCESS|EXC_CRASH|EXC_BREAKPOINT|SIGABRT|SIGSEGV/,
    /Unhandled JS Exception/,
    /RCTFatal/,
    /\bfatal error\b/i,
  ],
  // Not every `E ReactNativeJS` line: that tag is any console.error, and the
  // sinkholed analytics hosts make the update log one for each failed flush.
  android: [
    /FATAL EXCEPTION/,
    /Fatal signal \d+/,
    /com\.facebook\.react\.common\.JavascriptException/,
    /\[global-error-capture\] FATAL/,
    /Process com\.boardsesh\.app \(pid \d+\) has died/,
  ],
};

export function findFatalLogLines(platform: BootPlatform, deviceLog: string, limit = 20): string[] {
  const patterns = FATAL_LOG_PATTERNS[platform];
  const matches: string[] = [];
  for (const line of deviceLog.split(/\r?\n/)) {
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    matches.push(line.trim().slice(0, 400));
    if (matches.length === limit) break;
  }
  return matches;
}

/**
 * What the script collected, raw. It is written to the run's artifact as it is,
 * so a capture from a real run can be replayed through `judgeBoot` in a test.
 */
export interface BootCapture {
  expectedUpdateId: string;
  /** `id` of the bundle built into the binary under test. */
  embeddedUpdateId: string;
  /** `sqlite3 -json` output for `UPDATES_QUERY` when the first launch was stopped. */
  updatesAfterFirstLaunch: string;
  /** The same query at the end of the second launch. */
  updatesAfterSecondLaunch: string;
  /** Device clock, in milliseconds, when the second launch was started. */
  secondLaunchStartedAtMs: number;
  /** Seconds from the second launch to its first drawn content, or null if it never drew. */
  secondsToFirstScreen: number | null;
  /** Whether the app's process was still running at the end of the watch window. */
  processAliveAtEnd: boolean;
  /** Seconds the process was watched after the second launch started. */
  watchedSeconds: number;
  /** expo-updates' own log file, cut down by `updatesLogSince` to the second launch. */
  updatesLog: string;
  /** Crash lines found in the device log by `findFatalLogLines`. */
  fatalLogLines: readonly string[];
}

/** A capture with its tables and log parsed. */
export interface BootEvidence {
  expectedUpdateId: string;
  embeddedUpdateId: string;
  afterFirstLaunch: readonly UpdateRow[];
  afterSecondLaunch: readonly UpdateRow[];
  secondLaunchStartedAtMs: number;
  secondsToFirstScreen: number | null;
  processAliveAtEnd: boolean;
  watchedSeconds: number;
  fatalLogLines: readonly string[];
  /** expo-updates' own error and fatal log lines written during the second launch. */
  updatesLogErrors: readonly UpdatesLogLine[];
}

/**
 * The lines of expo-updates' log written at or after `sinceMs`, without the
 * one-per-asset lines (about 400 per launch on each platform).
 */
export function updatesLogSince(contents: string, sinceMs: number): string {
  return contents
    .split(/\r?\n/)
    .filter((line) => {
      const [entry] = parseUpdatesLog(line);
      return (
        entry !== undefined &&
        entry.timestamp >= sinceMs &&
        !entry.message.includes('didLoadAsset') &&
        !entry.message.startsWith('embeddedAssetFileMap')
      );
    })
    .join('\n');
}

export function evidenceFromCapture(capture: BootCapture): BootEvidence {
  return {
    expectedUpdateId: capture.expectedUpdateId,
    embeddedUpdateId: capture.embeddedUpdateId,
    afterFirstLaunch: parseUpdateRows(capture.updatesAfterFirstLaunch),
    afterSecondLaunch: parseUpdateRows(capture.updatesAfterSecondLaunch),
    secondLaunchStartedAtMs: capture.secondLaunchStartedAtMs,
    secondsToFirstScreen: capture.secondsToFirstScreen,
    processAliveAtEnd: capture.processAliveAtEnd,
    watchedSeconds: capture.watchedSeconds,
    fatalLogLines: capture.fatalLogLines,
    updatesLogErrors: parseUpdatesLog(capture.updatesLog).filter(
      (entry) => entry.level === 'error' || entry.level === 'fatal',
    ),
  };
}

export interface BootVerdict {
  passed: boolean;
  expectedUpdateId: string;
  /** The update the second launch ran, or null when expo-updates recorded none. */
  launchedUpdateId: string | null;
  /** True when the second launch ran the bundle built into the binary. */
  embeddedLaunch: boolean;
  /**
   * True when the second launch recorded no launched update at all. That is what
   * an emergency launch looks like from outside: expo-updates gave up on its
   * database and ran the embedded bundle without marking anything.
   */
  emergencyLaunch: boolean;
  secondsToFirstScreen: number | null;
  fatalLogLines: readonly string[];
  /** Why the check failed, one line each. Empty when it passed. */
  failures: string[];
}

function rowById(rows: readonly UpdateRow[], id: string): UpdateRow | null {
  return rows.find((row) => row.id === id) ?? null;
}

/**
 * The update a launch ran. expo-updates stamps `last_accessed` on the update it
 * launches and on nothing else, so the launched update is the one whose stamp
 * is at or after the moment the launch began.
 */
function launchedRow(rows: readonly UpdateRow[], launchStartedAtMs: number): UpdateRow | null {
  // One second of slack: the launch time is read from the device just before
  // the launch command, and SQLite stores the stamp in whole milliseconds.
  const launched = rows.filter((row) => row.lastAccessed >= launchStartedAtMs - 1_000);
  if (launched.length === 0) return null;
  return launched.reduce((latest, row) => (row.lastAccessed > latest.lastAccessed ? row : latest));
}

/**
 * The verdict. It passes only when all of these hold for the second launch:
 *
 *   - the first launch left the expected update on disk;
 *   - the second launch ran that update, not the embedded bundle and not nothing;
 *   - React drew content under it (expo-updates counts a successful launch on
 *     React Native's content-did-appear signal, and only for the launched update);
 *   - expo-updates recorded no failed launch for it;
 *   - the process was still alive at the end of the watch window;
 *   - the device log holds no crash line.
 */
export function judgeBoot(evidence: BootEvidence): BootVerdict {
  const failures: string[] = [];
  const expectedId = evidence.expectedUpdateId;
  const downloaded = rowById(evidence.afterFirstLaunch, expectedId);
  const final = rowById(evidence.afterSecondLaunch, expectedId);
  const launched = launchedRow(evidence.afterSecondLaunch, evidence.secondLaunchStartedAtMs);

  if (downloaded === null) {
    failures.push(
      `The first launch did not leave update ${expectedId} on disk. It was not offered, or the updater refused it ` +
        `(signature, runtime version, or an embedded bundle newer than the update).`,
    );
  } else if (!downloaded.ready) {
    failures.push(
      `Update ${expectedId} was still incomplete when the first launch was stopped: at least one asset did not download.`,
    );
  }
  if (launched === null) {
    failures.push(
      'The second launch recorded no launched update. That is an emergency launch of the embedded bundle, or a crash ' +
        'before expo-updates chose anything.',
    );
  } else if (launched.id !== expectedId) {
    failures.push(
      `The second launch ran ${launched.id === evidence.embeddedUpdateId ? 'the embedded bundle' : 'another update'} (${launched.id}), ` +
        `not ${expectedId}.`,
    );
  }
  if (final !== null && final.failedLaunchCount > 0) {
    failures.push(
      `expo-updates recorded ${final.failedLaunchCount} failed launch(es) of ${expectedId}: its JS threw before the first screen.`,
    );
  }
  if (launched?.id === expectedId) {
    const before = downloaded?.successfulLaunchCount ?? 0;
    if ((final?.successfulLaunchCount ?? 0) <= before) {
      failures.push(
        `Update ${expectedId} was launched but never drew its first screen in ${evidence.watchedSeconds}s ` +
          `(successful launches stayed at ${before}).`,
      );
    }
  }
  if (!evidence.processAliveAtEnd) {
    failures.push(`The app's process was gone ${evidence.watchedSeconds}s after the second launch.`);
  }
  if (evidence.fatalLogLines.length > 0) {
    failures.push(`The device log has ${evidence.fatalLogLines.length} crash line(s).`);
  }

  return {
    passed: failures.length === 0,
    expectedUpdateId: expectedId,
    launchedUpdateId: launched?.id ?? null,
    embeddedLaunch: launched?.id === evidence.embeddedUpdateId,
    emergencyLaunch: launched === null,
    secondsToFirstScreen: evidence.secondsToFirstScreen,
    fatalLogLines: evidence.fatalLogLines,
    failures,
  };
}

function describeRow(row: UpdateRow, embeddedUpdateId: string): string {
  return (
    `${row.id}${row.id === embeddedUpdateId ? ' (embedded)' : ''}: ${row.successfulLaunchCount} successful, ` +
    `${row.failedLaunchCount} failed, stamped ${row.headers?.['xprem-branch'] === undefined ? 'no branch' : `branch "${row.headers['xprem-branch']}"`}`
  );
}

/** The report a person reads: the verdict first, then the evidence it rests on. */
export function formatVerdict(
  platform: BootPlatform,
  branch: string,
  evidence: BootEvidence,
  verdict: BootVerdict,
): string {
  const lines = [
    `${verdict.passed ? 'PASS' : 'FAIL'}: ${platform} boot check on ${branch}`,
    `  expected update   ${verdict.expectedUpdateId}`,
    `  launched update   ${verdict.launchedUpdateId ?? 'none recorded'}`,
    `  embedded launch   ${verdict.embeddedLaunch ? 'yes' : 'no'}`,
    `  emergency launch  ${verdict.emergencyLaunch ? 'yes (nothing was launched from the update database)' : 'no'}`,
    `  first screen      ${verdict.secondsToFirstScreen === null ? 'never drawn' : `${verdict.secondsToFirstScreen.toFixed(1)}s after the second launch`}`,
    `  process           ${evidence.processAliveAtEnd ? 'alive' : 'gone'} after ${evidence.watchedSeconds}s`,
    `  crash log lines   ${verdict.fatalLogLines.length}`,
  ];
  // A JS error is one crash line per stack frame; the first few say what threw.
  for (const line of verdict.fatalLogLines.slice(0, 4)) lines.push(`    ${line.slice(0, 240)}`);
  lines.push('  updates on the device after the second launch:');
  if (evidence.afterSecondLaunch.length === 0) lines.push('    none');
  for (const row of evidence.afterSecondLaunch) lines.push(`    ${describeRow(row, evidence.embeddedUpdateId)}`);
  if (evidence.updatesLogErrors.length > 0) {
    lines.push('  expo-updates errors during the second launch:');
    for (const entry of evidence.updatesLogErrors.slice(0, 10)) {
      lines.push(`    [${entry.level}/${entry.code}] ${entry.message.replaceAll(/\s+/g, ' ').slice(0, 300)}`);
    }
  }
  for (const failure of verdict.failures) lines.push(`  why: ${failure}`);
  return lines.join('\n');
}
