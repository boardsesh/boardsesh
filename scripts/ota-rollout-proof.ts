/// <reference types="node" />

/**
 * The throwaway-branch proof for progressive rollouts on the xprem server.
 *
 * The rollout tooling (scripts/lib/ota-rollout.ts, the rollout mode of
 * scripts/mobile-ota-promote.ts) was written from the dashboard bundle and the
 * eoas client, and its write calls have never met the live server. This script
 * runs them, in a fixed sequence, against a scratch branch and a runtime version
 * no binary has, and writes down what the server did.
 *
 *   OTA_ADMIN_EMAIL=... OTA_ADMIN_PASSWORD=... EOO_TOKEN=... \
 *   EXPO_UPDATES_URL=https://updates.boardsesh.com/manifest \
 *     node --experimental-strip-types scripts/ota-rollout-proof.ts
 *
 * Flags: `--out-dir <dir>` (default `ota-rollout-proof-out`), `--branch <name>`
 * (accepted only so a wrong one can be refused), `--uuid-client-ids` (see
 * {@link proofClientIds}).
 *
 * What keeps it away from the fleet, all of it enforced in this file:
 *   - The branch is `pr-rollout-proof` and nothing else. It refuses a declared
 *     long-lived branch, a per-PR preview branch, and a branch the server maps
 *     to any channel.
 *   - The runtime version is `rollout-proof-<UTC timestamp>-<random>`, minted per
 *     run. A fingerprint or an app version is refused.
 *   - Every request goes through {@link createProofFetch}, which refuses any
 *     path that is not a read, the login, or a write addressed to that branch
 *     AND that runtime version. A bug elsewhere in the sequence cannot reach
 *     `production`: the request is never sent.
 *   - The updates are a three-line comment in a `.js` file.
 *   - It deletes nothing, remaps no channel and never touches Branch Surfing.
 *
 * Each step ends PASS (an expectation held), FAIL (it did not, or the call
 * broke) or OBSERVED (a question with no right answer, recorded). The transcript
 * goes to `$GITHUB_STEP_SUMMARY` when set and to stdout otherwise, and with the
 * machine-readable result into the output directory.
 *
 * Dependency-free: runs with no install in a job that holds the admin login.
 * See docs/mobile-ota-updates.md, "Running the throwaway-branch proof".
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PREVIEW_BRANCH_PATTERN,
  ROLLOUT_PROOF_BRANCH,
  desiredOtaState,
  otaReleasePolicy,
} from '../infra/ota/config.ts';
import type { OtaDesiredState, OtaHealthPolicy } from '../infra/ota/config.ts';
import {
  buildUploadFiles,
  classifyServedManifest,
  finalizeUpload,
  parseUploadLease,
  requestManifest,
  requestRepublish,
  requestRollbackToEmbedded,
  requestUploadLease,
  sleep,
  uploadLeaseFiles,
  uploadServerBase,
  validateExport,
} from './lib/ota-publish-protocol.ts';
import type { OtaPlatform, PublishTarget, UploadLease, ValidatedExport } from './lib/ota-publish-protocol.ts';
import { readRollout, readRolloutHealth, revertRollout, setRolloutPercentage } from './lib/ota-rollout.ts';
import type { ActiveRollout } from './lib/ota-rollout.ts';
import {
  XpremApiError,
  adminBaseUrl,
  adminLogin,
  createXpremAdminClient,
  mapWithConcurrency,
  sameId,
} from './lib/xprem-admin.mts';
import type { XpremAdminClient, XpremChannel, XpremUpdateListItem } from './lib/xprem-admin.mts';

const LOG = '[ota-rollout-proof]';
const PLATFORMS = ['ios', 'android'] as const;

/** `rollout-proof-20261005T101112Z-a1b2c3`: a UTC timestamp to the second and six random hex digits. */
const PROOF_RUNTIME_VERSION = /^rollout-proof-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

/** How many simulated devices each cohort probe asks as. */
const COHORT_SIZE = 40;

// ---------------------------------------------------------------------------
// Isolation guards
// ---------------------------------------------------------------------------

/** A runtime version for one run. No binary can hold it: a real one is a 40-character fingerprint. */
export function proofRuntimeVersion(now: Date, randomHex: string = randomBytes(3).toString('hex')): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
  return `rollout-proof-${stamp}-${randomHex}`;
}

/** Refuse any runtime version an installed app could send. */
export function assertProofRuntimeVersion(runtimeVersion: string): void {
  if (PROOF_RUNTIME_VERSION.test(runtimeVersion)) return;
  const looksReal = /^[0-9a-f]{40}$/i.test(runtimeVersion) || /^\d+(\.\d+)+$/.test(runtimeVersion);
  throw new Error(
    `Runtime version ${JSON.stringify(runtimeVersion)} is not a rollout-proof runtime version` +
      `${looksReal ? ' (it looks like a real fingerprint or app version)' : ''}. ` +
      'The proof only publishes under rollout-proof-<UTC timestamp>-<random>.',
  );
}

/**
 * Refuse every branch but the scratch one, and refuse that one too if the
 * declaration has started to treat it as long-lived. Checked before anything is
 * read from the server.
 */
export function assertProofBranch(branch: string, desired: Pick<OtaDesiredState, 'branches' | 'channels'>): void {
  if (branch !== ROLLOUT_PROOF_BRANCH) {
    throw new Error(`The rollout proof only runs against "${ROLLOUT_PROOF_BRANCH}", not "${branch}".`);
  }
  if (PREVIEW_BRANCH_PATTERN.test(branch)) {
    throw new Error(`"${branch}" is a per-PR preview branch. The rollout proof never publishes to one.`);
  }
  if (desired.branches.some((declared) => declared.name === branch)) {
    throw new Error(
      `"${branch}" is a declared long-lived branch in infra/ota/config.ts. The rollout proof refuses to publish to it.`,
    );
  }
  const channel = desired.channels.find((declared) => declared.branch === branch || declared.name === branch);
  if (channel) {
    throw new Error(
      `"${branch}" is named by the declared channel "${channel.name}" in infra/ota/config.ts. The rollout proof refuses to publish to it.`,
    );
  }
}

/**
 * Refuse a branch the live server serves through a channel: by name, by its
 * mapping, or as the target of a channel rollout. Devices on that channel would
 * be offered whatever the proof published.
 */
export function assertBranchNotServed(branch: string, channels: readonly XpremChannel[]): void {
  for (const channel of channels) {
    if (channel.releaseChannelName === branch) {
      throw new Error(`The server has a release channel named "${branch}". The rollout proof refuses to run.`);
    }
    if (channel.branchName === branch) {
      throw new Error(
        `The server maps channel "${channel.releaseChannelName}" to "${branch}". The rollout proof refuses to run.`,
      );
    }
    if (channel.rollout?.rolloutBranchName === branch) {
      throw new Error(
        `Channel "${channel.releaseChannelName}" is rolling out to "${branch}". The rollout proof refuses to run.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

const REDACTED_KEYS = /token|password|secret|authorization|signature|email|requestUploadUrl|^headers$/i;

/** Remove known secrets, emails, bearer credentials and JWTs from a string. */
export function createMasker(secrets: readonly (string | undefined)[]): (text: string) => string {
  // Longest first, so a secret that contains another is replaced whole.
  const known = secrets
    .filter((secret): secret is string => typeof secret === 'string' && secret.length >= 4)
    .sort((left, right) => right.length - left.length);
  return (text) => {
    let masked = text;
    for (const secret of known) masked = masked.split(secret).join('[masked]');
    return masked
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [masked]')
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[jwt]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  };
}

/**
 * A response body made safe to print: credential-bearing keys redacted, every
 * string masked and capped, long lists cut. Types are kept (a numeric id stays a
 * number), because whether an id is a number or a string is one of the questions.
 */
export function sanitizeBody(body: unknown, mask: (text: string) => string, depth = 0): unknown {
  if (typeof body === 'string') {
    const masked = mask(body);
    return masked.length > 300 ? `${masked.slice(0, 300)}… (${masked.length} chars)` : masked;
  }
  if (body === null || typeof body !== 'object') return body;
  if (depth >= 6) return '[nested]';
  if (Array.isArray(body)) {
    const shown = body.slice(0, 6).map((entry) => sanitizeBody(entry, mask, depth + 1));
    return body.length > 6 ? [...shown, `… (${body.length - 6} more)`] : shown;
  }
  return Object.fromEntries(
    Object.entries(body).map(([key, entry]) => [
      key,
      REDACTED_KEYS.test(key) ? '[redacted]' : sanitizeBody(entry, mask, depth + 1),
    ]),
  );
}

// ---------------------------------------------------------------------------
// The guarded, recording fetch
// ---------------------------------------------------------------------------

export interface Exchange {
  method: string;
  /** Path and query on the update server, or the origin alone for a storage upload. */
  path: string;
  status: number;
  /** The sanitized response body: parsed JSON when it was JSON, else text. */
  body: unknown;
  /** How many identical requests this line stands for. */
  count: number;
}

export interface ProofFetch {
  fetchImpl: typeof fetch;
  /** Hand over what was recorded since the last call. */
  takeExchanges: () => Exchange[];
  /** A position in the record, to read from later with `since`. */
  mark: () => number;
  /** What was recorded after a mark, without taking it. */
  since: (mark: number) => Exchange[];
  /** While `task` runs, identical requests are folded into one line with a count. */
  folded: <Result>(task: () => Promise<Result>) => Promise<Result>;
}

function requestParts(input: RequestInfo | URL, init: RequestInit | undefined): { url: URL; method: string } {
  const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
  return { url, method: (init?.method ?? 'GET').toUpperCase() };
}

/**
 * Why a request may not be sent, or null when it may.
 *
 * The allowlist is the isolation: reads of channels, branches and health; the
 * login; and writes only when the path names the proof branch and the request
 * names the proof runtime version. Anything else is a bug in this script, and
 * is stopped here rather than at the server.
 */
export function requestRefusal(
  request: { url: URL; method: string; headers: Headers },
  scope: { base: URL; appId: string; branch: string; runtimeVersion: string },
): string | null {
  const { url, method } = request;
  if (url.origin !== scope.base.origin) {
    // The only foreign requests are the presigned storage uploads a lease names.
    return method === 'PUT' && url.protocol === 'https:' ? null : `${method} to another origin`;
  }
  const prefix = scope.base.pathname.replace(/\/$/, '');
  if (!url.pathname.startsWith(`${prefix}/`)) return 'a path outside the update server';
  const path = url.pathname.slice(prefix.length);
  const app = `/api/apps/${encodeURIComponent(scope.appId)}`;
  const branch = encodeURIComponent(scope.branch);
  const runtimeVersion = encodeURIComponent(scope.runtimeVersion);

  if (method === 'POST' && path === '/auth/login') return null;
  if (method === 'GET' && path === '/manifest') {
    if (request.headers.get('xprem-branch') !== scope.branch) return 'a manifest probe of another branch';
    if (request.headers.get('expo-runtime-version') !== scope.runtimeVersion) {
      return 'a manifest probe of another runtime version';
    }
    return null;
  }
  if (method === 'GET' && (path === `${app}/channels` || path === `${app}/branches`)) return null;
  if (
    method === 'GET' &&
    (path === `${app}/identity/update-health` || path === `${app}/observe/update-health/history`)
  ) {
    return null;
  }
  const scoped = `${app}/branch/${branch}/runtimeVersion/${runtimeVersion}/`;
  if (path.startsWith(scoped)) {
    const rest = path.slice(scoped.length);
    if (method === 'GET' && (rest === 'rollout' || rest === 'updates' || /^updates\/[^/]+$/.test(rest))) return null;
    if (method === 'PUT' && rest === 'rollout') return null;
    if (method === 'POST' && rest === 'rollout/revert') return null;
    return `${method} ${rest} is not a call the proof makes`;
  }
  const publish = new RegExp(
    `^/${scope.appId}/(requestUploadUrl|markUpdateAsUploaded|republish|rollback)/${scope.branch}$`,
  );
  if (method === 'POST' && publish.test(path)) {
    return url.searchParams.get('runtimeVersion') === scope.runtimeVersion
      ? null
      : 'a publish call for another runtime version';
  }
  // A local-bucket server takes the files itself. The lease's signed upload
  // token pins the path it may write, and only a lease for the proof branch is
  // ever requested.
  if (method === 'PUT' && path === `/${scope.appId}/uploadLocalFile`) return null;
  return `${method} ${path} is outside the proof's allowlist`;
}

export function createProofFetch(options: {
  base: URL;
  appId: string;
  branch: string;
  runtimeVersion: string;
  mask: (text: string) => string;
  fetchImpl: typeof fetch;
}): ProofFetch {
  let exchanges: Exchange[] = [];
  /** Where the current fold began, or null outside one. Only its own lines are merged. */
  let foldStart: number | null = null;

  const record = (exchange: Omit<Exchange, 'count'>): void => {
    if (foldStart !== null) {
      const same = exchanges
        .slice(foldStart)
        .find(
          (earlier) =>
            earlier.method === exchange.method && earlier.path === exchange.path && earlier.status === exchange.status,
        );
      if (same) {
        same.count += 1;
        return;
      }
    }
    exchanges.push({ ...exchange, count: 1 });
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { url, method } = requestParts(input, init);
    const refusal = requestRefusal({ url, method, headers: new Headers(init?.headers) }, options);
    if (refusal) throw new Error(`Refused before sending: ${refusal} (${method} ${url.origin}${url.pathname}).`);
    const response = await options.fetchImpl(input, init);
    const onServer = url.origin === options.base.origin;
    // A storage URL is presigned: its path and query are the credential.
    const path = onServer ? options.mask(`${url.pathname}${url.search}`) : `${url.origin}/[presigned upload]`;
    // A folded line stands for many answers that differ, so it keeps the status
    // and no body. A storage answer is never read.
    let body: unknown = null;
    if (onServer && foldStart === null) {
      const responseText = await response.clone().text();
      try {
        body = sanitizeBody(JSON.parse(responseText) as unknown, options.mask);
      } catch {
        // A multipart manifest or a plain-text refusal.
        body = sanitizeBody(responseText, options.mask);
      }
    }
    record({ method, path, status: response.status, body });
    return response;
  }) as typeof fetch;

  return {
    fetchImpl,
    takeExchanges: () => {
      const taken = exchanges;
      exchanges = [];
      return taken;
    },
    mark: () => exchanges.length,
    since: (mark) => exchanges.slice(mark),
    folded: async (task) => {
      foldStart = exchanges.length;
      try {
        return await task();
      } finally {
        foldStart = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic exports
// ---------------------------------------------------------------------------

export interface SyntheticExport {
  platform: OtaPlatform;
  directory: string;
  /** Hex, as validateExport wants it. */
  bundleSha256: string;
  /** Base64url, as a served manifest names the launch asset. */
  bundleHash: string;
}

/**
 * The smallest export the server accepts as an update, written to disk.
 *
 * xprem 3.2.5 validates three things, none of them the JavaScript: the `files`
 * list of requestUploadUrl must hold exactly one launch file and well-formed
 * hashes; markUpdateAsUploaded reads the update's `metadata.json` and wants a
 * bundle path in it; and every hash the list named must exist in storage. A
 * manifest read additionally serves `expoConfig.json` as `extra.expoClient`. So
 * the export is those two config files and one bundle, with no assets.
 *
 * The bundle is a comment. Each label, platform and run gets different bytes,
 * because the server refuses a publish whose files equal the branch's newest
 * update (HTTP 406).
 */
export function writeSyntheticExport(options: {
  root: string;
  platform: OtaPlatform;
  appId: string;
  runtimeVersion: string;
  label: string;
}): SyntheticExport {
  const { platform, label, runtimeVersion } = options;
  const directory = join(options.root, `${label}-${platform}`);
  const bundlePath = `_expo/static/js/${platform}/rollout-proof-${label.toLowerCase()}.js`;
  mkdirSync(join(directory, '_expo', 'static', 'js', platform), { recursive: true });
  const bundle = Buffer.from(
    '// Boardsesh OTA rollout proof. Inert: this is not an app bundle and nothing runs it.\n' +
      `// update ${label}, ${platform}, runtime ${runtimeVersion}\n`,
  );
  writeFileSync(join(directory, bundlePath), bundle);
  writeFileSync(
    join(directory, 'metadata.json'),
    JSON.stringify({ version: 0, bundler: 'metro', fileMetadata: { [platform]: { bundle: bundlePath, assets: [] } } }),
  );
  writeFileSync(
    join(directory, 'expoConfig.json'),
    JSON.stringify({
      name: 'Boardsesh rollout proof',
      slug: 'boardsesh-rollout-proof',
      runtimeVersion,
      updates: { requestHeaders: { 'expo-app-id': options.appId, 'expo-channel-name': 'production' } },
      extra: { rolloutProof: { label, platform } },
    }),
  );
  return {
    platform,
    directory,
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    bundleHash: createHash('sha256').update(bundle).digest('base64url'),
  };
}

// ---------------------------------------------------------------------------
// The step runner
// ---------------------------------------------------------------------------

export type StepOutcome = 'PASS' | 'FAIL' | 'OBSERVED' | 'SKIPPED';

export interface Finding {
  outcome: Exclude<StepOutcome, 'SKIPPED'>;
  text: string;
}

export interface StepResult {
  id: string;
  title: string;
  outcome: StepOutcome;
  /** Why a SKIPPED step did not run. Null for every other outcome. */
  skippedBecause: string | null;
  findings: Finding[];
  exchanges: Exchange[];
  /** Values a later reader may want without parsing prose. */
  data: Record<string, unknown>;
}

export interface StepRecorder {
  /** An expectation held. */
  pass: (text: string) => void;
  /** An expectation did not hold. Later steps still run. */
  fail: (text: string) => void;
  /** Something with no right answer, written down. */
  observe: (text: string) => void;
  /** `pass` or `fail` on a condition, with one sentence for each. */
  expect: (condition: boolean, passText: string, failText: string) => void;
  /** A failure after which the steps that need this one mean nothing. */
  block: (text: string) => never;
  record: (key: string, value: unknown) => void;
}

export interface StepDefinition {
  id: string;
  title: string;
  /** Steps that must have run without a blocking failure. */
  needs?: readonly string[];
  run: (recorder: StepRecorder) => Promise<void>;
}

class BlockingFailure extends Error {}

/** A step is FAIL on any failed expectation, PASS when at least one held, and OBSERVED otherwise. */
export function classifyStep(findings: readonly Finding[]): Exclude<StepOutcome, 'SKIPPED'> {
  if (findings.some((finding) => finding.outcome === 'FAIL')) return 'FAIL';
  return findings.some((finding) => finding.outcome === 'PASS') ? 'PASS' : 'OBSERVED';
}

/**
 * Run the steps in order. A step that throws, or calls `block`, is FAIL and is
 * marked broken; every later step that needs a broken or skipped step is
 * SKIPPED with the reason. A step whose expectations merely failed is FAIL and
 * its dependants still run. Every step gets a result, so the summary is whole.
 */
export async function runSteps(
  steps: readonly StepDefinition[],
  takeExchanges: () => Exchange[],
  mask: (text: string) => string,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const unusable = new Set<string>();
  for (const step of steps) {
    const missing = (step.needs ?? []).filter((needed) => unusable.has(needed));
    if (missing.length > 0) {
      unusable.add(step.id);
      results.push({
        id: step.id,
        title: step.title,
        outcome: 'SKIPPED',
        skippedBecause: `step ${missing.join(', ')} did not complete`,
        findings: [],
        exchanges: [],
        data: {},
      });
      continue;
    }
    const findings: Finding[] = [];
    const data: Record<string, unknown> = {};
    const recorder: StepRecorder = {
      pass: (text) => findings.push({ outcome: 'PASS', text: mask(text) }),
      fail: (text) => findings.push({ outcome: 'FAIL', text: mask(text) }),
      observe: (text) => findings.push({ outcome: 'OBSERVED', text: mask(text) }),
      expect: (condition, passText, failText) =>
        findings.push({ outcome: condition ? 'PASS' : 'FAIL', text: mask(condition ? passText : failText) }),
      block: (text) => {
        throw new BlockingFailure(text);
      },
      record: (key, value) => {
        data[key] = value;
      },
    };
    try {
      await step.run(recorder);
    } catch (error) {
      unusable.add(step.id);
      const reason = error instanceof Error ? error.message : String(error);
      findings.push({
        outcome: 'FAIL',
        text: mask(error instanceof BlockingFailure ? reason : `The step stopped on an error: ${reason}`),
      });
    }
    results.push({
      id: step.id,
      title: step.title,
      outcome: classifyStep(findings),
      skippedBecause: null,
      findings,
      exchanges: takeExchanges(),
      data,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

/** One platform's half of a published synthetic update. */
interface PublishedUpdate {
  /** The numeric id the lease named, as a string. */
  updateId: string;
  /** How the lease serialised the id: `number` or `string`. */
  leaseIdType: string;
  /** The id a device reports, from the finalize answer. Null when the server sent none. */
  updateUUID: string | null;
  bundleHash: string;
  /** The percentage the lease echoed, or null when it echoed none. */
  echoedRolloutPercentage: number | null;
}

type PublishOutcome =
  | { kind: 'published'; updates: Record<OtaPlatform, PublishedUpdate> }
  | { kind: 'refused'; stage: 'lease' | 'finalize'; platform: OtaPlatform; status: number; body: string };

type ProbeAnswer =
  | { kind: 'update'; updateUUID: string; branch: string | null; launchHash: string | null }
  | { kind: 'noUpdateAvailable' | 'rollBackToEmbedded' | 'unrecognized' }
  | { kind: 'http'; status: number };

export interface ProofOptions {
  /** `EXPO_UPDATES_URL`: the manifest endpoint. Publish and admin calls go to its origin. */
  manifestUrl: string;
  adminEmail: string;
  adminPassword: string;
  publishToken: string;
  branch?: string;
  /** Ask as random UUIDs instead of `rollout-proof-…` ids. See {@link proofClientIds}. */
  uuidClientIds?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
  healthPolicy?: OtaHealthPolicy;
  /** Waits between attempts while a publish or a rollout write becomes visible. */
  settleDelaysMs?: readonly number[];
  /** The wait before a batch of manifest probes that follows a write. */
  probeSettleMs?: number;
  /** The gap between two file uploads. Matches this repo's `eoas --upload-rate 5`. */
  uploadPaceMs?: number;
}

export interface ProofReport {
  server: string;
  branch: string;
  runtimeVersion: string;
  startedAt: string;
  finishedAt: string;
  clientIdKind: 'non-uuid' | 'uuid';
  steps: StepResult[];
  /** True when no step failed. Skipped steps do not count as passed. */
  ok: boolean;
}

/**
 * The simulated device ids the cohort probes send as `EAS-Client-ID`.
 *
 * By default they are NOT UUIDs. The server buckets a rollout on a hash of the
 * raw header (internal/rollout/bucketing.go), so any distinct string draws a
 * bucket; but its Observe check-in recorder (ee/observe/checkins.go) registers a
 * polling device only when the header parses as a UUID. Non-UUID ids therefore
 * sample the rollout without adding 40 phantom devices to the device registry.
 *
 * `uuid: true` sends random UUIDs, exactly as a phone does, at that cost. It is
 * there for the case where the live server turns out to ignore the others.
 */
export function proofClientIds(runtimeVersion: string, uuid: boolean): string[] {
  return Array.from({ length: COHORT_SIZE }, (unused, index) =>
    uuid ? randomUUID() : `${runtimeVersion}-device-${String(index + 1).padStart(2, '0')}`,
  );
}

/** The newest listed update per platform. Numeric ids are timestamps, so the largest is the newest. */
function headUpdates(listed: readonly XpremUpdateListItem[]): Partial<Record<string, XpremUpdateListItem>> {
  const heads: Partial<Record<string, XpremUpdateListItem>> = {};
  for (const update of listed) {
    const current = heads[update.platform];
    if (!current || BigInt(String(update.updateId)) > BigInt(String(current.updateId))) heads[update.platform] = update;
  }
  return heads;
}

const describeRollouts = (rollouts: readonly ActiveRollout[]): string =>
  rollouts.length === 0
    ? 'no live rollout'
    : rollouts.map((rollout) => `${rollout.platform} update ${rollout.updateId} at ${rollout.percentage}%`).join(', ');

export async function runRolloutProof(options: ProofOptions): Promise<ProofReport> {
  const branch = options.branch ?? ROLLOUT_PROOF_BRANCH;
  assertProofBranch(branch, desiredOtaState);
  const startedAt = options.now ?? new Date();
  const runtimeVersion = proofRuntimeVersion(startedAt);
  assertProofRuntimeVersion(runtimeVersion);
  if (!options.adminEmail || !options.adminPassword) throw new Error('Set OTA_ADMIN_EMAIL and OTA_ADMIN_PASSWORD.');
  if (!options.publishToken) throw new Error('Set EOO_TOKEN (the publish token).');

  const base = uploadServerBase(options.manifestUrl);
  const appId = desiredOtaState.appId;
  const mask = createMasker([options.adminEmail, options.adminPassword, options.publishToken]);
  const proofFetch = createProofFetch({
    base,
    appId,
    branch,
    runtimeVersion,
    mask,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  const { fetchImpl } = proofFetch;
  const settleDelaysMs = options.settleDelaysMs ?? [1_000, 2_000, 4_000, 8_000];
  const probeSettleMs = options.probeSettleMs ?? 3_000;
  const uploadPaceMs = options.uploadPaceMs ?? 200;
  const healthPolicy = options.healthPolicy ?? otaReleasePolicy.health;
  const publishTarget: PublishTarget = { base, appId, branch, token: options.publishToken, fetchImpl };
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-rollout-proof-'));
  const clientIds = proofClientIds(runtimeVersion, options.uuidClientIds === true);

  // Shared across steps. Filled as the sequence goes.
  let client: XpremAdminClient | null = null;
  const admin = (): XpremAdminClient => {
    if (!client) throw new Error('The admin session was never opened.');
    return client;
  };
  const published: Record<string, Record<OtaPlatform, PublishedUpdate>> = {};
  /** Null until a probe has shown whether the server answers from the proof branch. */
  let probesAnswerFromBranch: boolean | null = null;
  /** Per platform, the client ids that were served the canary at the last cohort probe. */
  let canaryCohort: Record<OtaPlatform, Set<string>> | null = null;
  /** How many write calls each lib operation needed, for step j. */
  const writeCalls: { operation: string; calls: number; platformsBefore: number; platformsAfter: string }[] = [];

  let lastUploadStart = 0;
  const paceUpload = async (): Promise<void> => {
    const remainingMs = lastUploadStart + uploadPaceMs - Date.now();
    if (remainingMs > 0) await sleep(remainingMs);
    lastUploadStart = Date.now();
  };

  const commitHashOf = (label: string): string =>
    createHash('sha1').update(`rollout-proof:${runtimeVersion}:${label}`).digest('hex');

  /**
   * Publish one synthetic update for both platforms through the shared protocol.
   * Both leases are requested before either is finalized, as the promote script
   * does: the two platforms share one runtime version here, and the server's
   * publish guard is per branch and runtime version, so a lease requested after
   * the other platform's rollout went live would be refused.
   *
   * With `leaseOnly`, it stops after the lease answers and never uploads: that
   * is how a publish that is expected to be refused is attempted without
   * publishing anything if it is not.
   */
  const publishSynthetic = async (
    label: string,
    rolloutPercentage: number | null,
    leaseOnly = false,
  ): Promise<PublishOutcome> => {
    const publishGroup = randomUUID();
    const exports = {} as Record<OtaPlatform, { files: ValidatedExport; synthetic: SyntheticExport }>;
    for (const platform of PLATFORMS) {
      const synthetic = writeSyntheticExport({ root: workDirectory, platform, appId, runtimeVersion, label });
      exports[platform] = { synthetic, files: validateExport(synthetic.directory, platform, synthetic.bundleSha256) };
    }
    const leases = {} as Record<OtaPlatform, { lease: UploadLease; idType: string; echoed: number | null }>;
    for (const platform of PLATFORMS) {
      const response = await requestUploadLease(publishTarget, {
        platform,
        runtimeVersion,
        commitHash: commitHashOf(label),
        publishGroup,
        rolloutPercentage,
        files: buildUploadFiles(exports[platform].files),
        message: `rollout proof ${runtimeVersion}: update ${label} (synthetic, inert)`,
      });
      if (!response.ok) {
        return { kind: 'refused', stage: 'lease', platform, status: response.status, body: await response.text() };
      }
      const leaseJson = (await response.json()) as Record<string, unknown>;
      leases[platform] = {
        lease: parseUploadLease(leaseJson, exports[platform].files.files, base, appId),
        idType: typeof leaseJson.updateId,
        echoed: typeof leaseJson.rolloutPercentage === 'number' ? leaseJson.rolloutPercentage : null,
      };
    }
    const updates = {} as Record<OtaPlatform, PublishedUpdate>;
    for (const platform of PLATFORMS) {
      const { lease, idType, echoed } = leases[platform];
      updates[platform] = {
        updateId: lease.updateId,
        leaseIdType: idType,
        updateUUID: null,
        bundleHash: exports[platform].synthetic.bundleHash,
        echoedRolloutPercentage: echoed,
      };
    }
    if (leaseOnly) return { kind: 'published', updates };
    for (const platform of PLATFORMS) {
      const { lease } = leases[platform];
      await uploadLeaseFiles(lease, exports[platform].files, publishTarget, paceUpload);
      const response = await finalizeUpload(publishTarget, { platform, runtimeVersion, updateId: lease.updateId });
      if (!response.ok) {
        return { kind: 'refused', stage: 'finalize', platform, status: response.status, body: await response.text() };
      }
      const finalized = (await response.json().catch(() => ({}))) as { updateUUID?: unknown };
      updates[platform].updateUUID = typeof finalized.updateUUID === 'string' ? finalized.updateUUID : null;
    }
    published[label] = updates;
    return { kind: 'published', updates };
  };

  /** Publish and require success, or end the step. */
  const publishOrBlock = async (
    recorder: StepRecorder,
    label: string,
    rolloutPercentage: number | null,
  ): Promise<Record<OtaPlatform, PublishedUpdate>> => {
    const outcome = await publishSynthetic(label, rolloutPercentage);
    if (outcome.kind === 'refused') {
      return recorder.block(
        `Publishing update ${label} was refused at ${outcome.stage} for ${outcome.platform}: HTTP ${outcome.status}, ` +
          `body ${JSON.stringify(outcome.body.slice(0, 300))}.`,
      );
    }
    return outcome.updates;
  };

  /** Which published update a manifest id or launch hash belongs to. */
  const labelOf = (answer: ProbeAnswer): string => {
    if (answer.kind !== 'update') return answer.kind === 'http' ? `HTTP ${answer.status}` : answer.kind;
    for (const [label, updates] of Object.entries(published)) {
      for (const platform of PLATFORMS) {
        if (updates[platform].updateUUID?.toLowerCase() === answer.updateUUID.toLowerCase()) return label;
      }
    }
    for (const [label, updates] of Object.entries(published)) {
      for (const platform of PLATFORMS) {
        if (updates[platform].bundleHash !== answer.launchHash) continue;
        // Without a UUID from the finalize answer, the bundle is the only way to name the update.
        return updates[platform].updateUUID === null ? label : `${label} (same bundle, new update id)`;
      }
    }
    return `unknown update ${answer.updateUUID}`;
  };

  const probe = async (platform: OtaPlatform, easClientId?: string): Promise<ProbeAnswer> => {
    const response = await requestManifest({
      manifestUrl: options.manifestUrl,
      platform,
      runtimeVersion,
      appId,
      branch,
      easClientId,
      fetchImpl,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: 'http', status: response.status };
    }
    const served = classifyServedManifest(await response.text());
    if (served.kind !== 'update') return { kind: served.kind };
    const extra = served.manifest.extra as { branch?: unknown } | undefined;
    const launchAsset = served.manifest.launchAsset as { hash?: unknown } | undefined;
    return {
      kind: 'update',
      updateUUID: typeof served.manifest.id === 'string' ? served.manifest.id : '',
      branch: typeof extra?.branch === 'string' ? extra.branch : null,
      launchHash: typeof launchAsset?.hash === 'string' ? launchAsset.hash : null,
    };
  };

  /** What a device that sends no `EAS-Client-ID` is served, per platform. */
  const probeAnonymous = async (): Promise<Record<OtaPlatform, ProbeAnswer>> => {
    await sleep(probeSettleMs);
    return { ios: await probe('ios'), android: await probe('android') };
  };

  /** Ask as every simulated device, per platform. Returns the label each was served. */
  const probeCohort = async (): Promise<Record<OtaPlatform, Map<string, string>>> => {
    await sleep(probeSettleMs);
    return proofFetch.folded(async () => {
      const served = {} as Record<OtaPlatform, Map<string, string>>;
      for (const platform of PLATFORMS) {
        const labels = await mapWithConcurrency(clientIds, 4, async (clientId) =>
          labelOf(await probe(platform, clientId)),
        );
        served[platform] = new Map(clientIds.map((clientId, index) => [clientId, labels[index]]));
      }
      return served;
    });
  };

  const tally = (served: Map<string, string>): string => {
    const counts = new Map<string, number>();
    for (const label of served.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
    return [...counts.entries()].map(([label, count]) => `${count} got ${label}`).join(', ');
  };

  /** Read the live rollout, waiting out the moment a publish takes to become visible. */
  const waitForRollout = async (expectLive: boolean): Promise<ActiveRollout[]> => {
    let rollouts = await readRollout(admin(), branch, runtimeVersion);
    for (const delayMs of settleDelaysMs) {
      if (rollouts.length > 0 === expectLive) break;
      await sleep(delayMs);
      rollouts = await readRollout(admin(), branch, runtimeVersion);
    }
    return rollouts;
  };

  const target = { branch, runtimeVersion, platform: 'all' as const };

  /**
   * Run a read whose failure is a finding and not a reason to stop: the update
   * list, update details and health have never been read from the live server,
   * and a shape this client cannot parse must not cost the rest of the run.
   */
  const attempt = async <Result>(
    recorder: StepRecorder,
    what: string,
    read: () => Promise<Result>,
  ): Promise<Result | null> => {
    try {
      return await read();
    } catch (error) {
      recorder.fail(`${what} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const readHeads = async (recorder: StepRecorder): Promise<Partial<Record<string, XpremUpdateListItem>> | null> => {
    const listed = await attempt(recorder, 'The update list', () => admin().getUpdates(branch, runtimeVersion));
    return listed && headUpdates(listed);
  };

  /** Run a lib write and note how many HTTP writes it took, for step j. */
  const countedWrite = async (
    operation: string,
    write: () => Promise<ActiveRollout[]>,
  ): Promise<{ changed: ActiveRollout[]; after: ActiveRollout[] }> => {
    const before = await readRollout(admin(), branch, runtimeVersion);
    const mark = proofFetch.mark();
    const changed = await write();
    const during = proofFetch.since(mark);
    const after = await readRollout(admin(), branch, runtimeVersion);
    writeCalls.push({
      operation,
      calls: during.filter((exchange) => exchange.method !== 'GET').reduce((sum, exchange) => sum + exchange.count, 0),
      platformsBefore: before.length,
      platformsAfter: describeRollouts(after),
    });
    return { changed, after };
  };
  const steps: StepDefinition[] = [
    {
      id: 'guards',
      title: 'Sign in and confirm the branch is not served by any channel',
      run: async (recorder) => {
        const adminBase = adminBaseUrl(options.manifestUrl);
        const token = await adminLogin({
          baseUrl: adminBase,
          email: options.adminEmail,
          password: options.adminPassword,
          fetchImpl,
        });
        client = createXpremAdminClient({ baseUrl: adminBase, appId, token, fetchImpl });
        const channels = await client.getChannels();
        assertBranchNotServed(branch, channels);
        recorder.pass(
          `No release channel is named "${branch}", maps to it, or is rolling out to it ` +
            `(${channels.length} channel(s) read).`,
        );
        const surfing = channels.find((channel) => channel.releaseChannelName === desiredOtaState.channels[0].name);
        recorder.observe(
          `Branch Surfing on "${surfing?.releaseChannelName ?? 'production'}" is ` +
            `${surfing?.branchSurfing?.enabled ? 'on' : 'off'} with pattern "${surfing?.branchSurfing?.pattern ?? ''}". ` +
            'It was read and not changed.',
        );
        const existing = (await client.getBranches()).find((candidate) => candidate.branchName === branch);
        recorder.observe(
          existing
            ? `The branch already exists (protected: ${existing.protected}). This run adds a new runtime version to it.`
            : 'The branch does not exist yet. The first publish creates it.',
        );
      },
    },
    {
      id: 'a',
      title: 'Publish update A at 100% for ios and android',
      needs: ['guards'],
      run: async (recorder) => {
        const updateA = await publishOrBlock(recorder, 'A', null);
        recorder.record('updateA', updateA);
        recorder.pass(
          `Update A was accepted for both platforms (ios ${updateA.ios.updateId}, android ${updateA.android.updateId}).`,
        );
        recorder.observe(
          `The lease serialises updateId as a ${updateA.ios.leaseIdType}. The finalize answer ` +
            `${updateA.ios.updateUUID ? `carries updateUUID ${updateA.ios.updateUUID}` : 'carries no updateUUID'}.`,
        );
        const rollouts = await waitForRollout(false);
        recorder.expect(
          rollouts.length === 0,
          'No rollout is active after a 100% publish.',
          `A rollout is active after a 100% publish: ${describeRollouts(rollouts)}.`,
        );
        const heads = await readHeads(recorder);
        for (const platform of heads ? PLATFORMS : []) {
          const head = heads?.[platform];
          recorder.expect(
            head !== undefined && sameId(head.updateId, updateA[platform].updateId),
            `The admin API lists A as the head for ${platform}.`,
            `The admin API head for ${platform} is ${head ? head.updateId : 'missing'}, not A (${updateA[platform].updateId}).`,
          );
        }
        // Establish, before any rollout exists, whether a probe is answered from
        // this branch at all. Everything a later probe says depends on it.
        const anonymous = await attempt(recorder, 'The manifest', probeAnonymous);
        probesAnswerFromBranch =
          anonymous !== null &&
          PLATFORMS.every((platform) => {
            const answer = anonymous[platform];
            return answer.kind === 'update' && answer.branch === branch && labelOf(answer) === 'A';
          });
        recorder.record('anonymousProbe', anonymous);
        recorder.observe(
          probesAnswerFromBranch
            ? `An anonymous manifest request with xprem-branch: ${branch} is answered from that branch ` +
                '(extra.branch matches) and serves A. Manifest probes are meaningful for this run.'
            : `An anonymous manifest request with xprem-branch: ${branch} was NOT answered with A from that branch ` +
                `(ios: ${anonymous ? labelOf(anonymous.ios) : 'no answer'}, android: ` +
                `${anonymous ? labelOf(anonymous.android) : 'no answer'}). Branch Surfing does not serve this branch ` +
                'to the probe, so every manifest-based check below is skipped rather than misread.',
        );
      },
    },
    {
      id: 'b',
      title: 'Publish update B with rolloutPercentage=10',
      needs: ['a'],
      run: async (recorder) => {
        const updateB = await publishOrBlock(recorder, 'B', 10);
        recorder.record('updateB', updateB);
        for (const platform of PLATFORMS) {
          recorder.expect(
            updateB[platform].echoedRolloutPercentage === 10,
            `The ${platform} lease echoes rolloutPercentage 10.`,
            `The ${platform} lease echoed ${updateB[platform].echoedRolloutPercentage ?? 'nothing'}, not 10.`,
          );
        }
        const rollouts = await waitForRollout(true);
        if (rollouts.length === 0) recorder.block('No rollout is live after publishing B at 10%.');
        recorder.record('rollout', rollouts);
        const rawRollout = proofFetch
          .since(0)
          .filter((exchange) => exchange.method === 'GET' && exchange.path.endsWith('/rollout'))
          .at(-1)?.body as { updates?: Record<string, unknown>[] } | undefined;
        const firstRaw = rawRollout?.updates?.[0];
        recorder.observe(
          `GET …/rollout returns ${rollouts.length} entr${rollouts.length === 1 ? 'y' : 'ies'}, one per platform ` +
            `(${rollouts.map((rollout) => rollout.platform).join(', ')}), not one for both. updateId is a ` +
            `${typeof firstRaw?.updateId}, controlUpdateId a ${typeof firstRaw?.controlUpdateId}, createdAt ` +
            `${JSON.stringify(firstRaw?.createdAt ?? null)}. Keys: ${Object.keys(firstRaw ?? {}).join(', ')}.`,
        );
        const updateA = published.A;
        for (const platform of PLATFORMS) {
          const live = rollouts.find((rollout) => rollout.platform === platform);
          recorder.expect(
            live !== undefined && sameId(live.updateId, updateB[platform].updateId) && live.percentage === 10,
            `${platform}: update B (${updateB[platform].updateId}) is rolling out at 10%.`,
            `${platform}: expected B (${updateB[platform].updateId}) at 10%, found ${live ? `${live.updateId} at ${live.percentage}%` : 'no rollout'}.`,
          );
          recorder.expect(
            live?.controlUpdateId != null && sameId(live.controlUpdateId, updateA[platform].updateId),
            `${platform}: controlUpdateId is present and names A (${updateA[platform].updateId}).`,
            `${platform}: controlUpdateId is ${live?.controlUpdateId ?? 'absent'}, expected A (${updateA[platform].updateId}).`,
          );
        }
      },
    },
    {
      id: 'c',
      title: 'What devices are served while B rolls out at 10%',
      needs: ['b'],
      run: async (recorder) => {
        if (!probesAnswerFromBranch) {
          recorder.observe(
            'Skipped: step a showed that manifest probes are not answered from this branch, so who gets A or B ' +
              'cannot be read from here. The rollout state itself is covered by the admin reads.',
          );
          return;
        }
        const anonymous = await probeAnonymous();
        recorder.record('anonymousProbe', anonymous);
        for (const platform of PLATFORMS) {
          const label = labelOf(anonymous[platform]);
          recorder.expect(
            label === 'A',
            `${platform}: a request with no EAS-Client-ID is served A, the control.`,
            `${platform}: a request with no EAS-Client-ID is served ${label}, not the control A.`,
          );
        }
        const first = await probeCohort();
        const second = await probeCohort();
        canaryCohort = { ios: new Set(), android: new Set() };
        for (const platform of PLATFORMS) {
          const canary = [...first[platform].entries()].filter(([, label]) => label === 'B').map(([id]) => id);
          canaryCohort[platform] = new Set(canary);
          recorder.observe(
            `${platform}: of ${COHORT_SIZE} distinct client ids, ${tally(first[platform])}. ` +
              `About ${Math.round(COHORT_SIZE * 0.1)} would be 10%; with ${COHORT_SIZE} ids anything from 0 to 10 is ordinary.`,
          );
          const strangers = [...first[platform].values()].filter((label) => label !== 'A' && label !== 'B');
          recorder.expect(
            strangers.length === 0,
            `${platform}: every device was served A or B.`,
            `${platform}: ${strangers.length} device(s) were served neither A nor B: ${[...new Set(strangers)].join(', ')}.`,
          );
          const moved = clientIds.filter((id) => first[platform].get(id) !== second[platform].get(id));
          recorder.expect(
            moved.length === 0,
            `${platform}: asking again with the same ${COHORT_SIZE} ids gave every one the same update. Assignment is sticky.`,
            `${platform}: ${moved.length} of ${COHORT_SIZE} ids were served a different update on the second ask.`,
          );
        }
        recorder.record('canaryClientIds', {
          ios: [...canaryCohort.ios],
          android: [...canaryCohort.android],
        });
      },
    },
    {
      id: 'd',
      title: 'Publish, republish and rollback while the rollout is live',
      needs: ['b'],
      run: async (recorder) => {
        const attempt = await publishSynthetic('C-blocked', null, true);
        if (attempt.kind === 'refused') {
          recorder.expect(
            attempt.status === 409,
            `Publishing at 100% during the rollout is refused with HTTP 409 at ${attempt.stage} (${attempt.platform}). ` +
              `Body: ${JSON.stringify(attempt.body.slice(0, 300))}.`,
            `Publishing during the rollout was refused with HTTP ${attempt.status}, not 409, at ${attempt.stage} ` +
              `(${attempt.platform}). Body: ${JSON.stringify(attempt.body.slice(0, 300))}.`,
          );
        } else {
          recorder.fail(
            'The server handed out an upload lease for a 100% publish while a rollout is live. Nothing was uploaded ' +
              'or finalized, so the lease is an inert row; but the request-time lock did not hold.',
          );
        }
        // The publish token can be limited, per branch, to publishing only. Then
        // the server refuses a republish or a rollback for that reason first, and
        // the answer says nothing about the lock.
        const expectLocked = (what: string, status: number, body: string): void => {
          if (status === 401 || status === 403) {
            recorder.observe(
              `${what} during the rollout answered HTTP ${status}: the publish token is not allowed to do it on this ` +
                `branch, so whether the lock blocks it could not be tested. Body: ${JSON.stringify(body)}.`,
            );
            return;
          }
          recorder.expect(
            status === 409,
            `${what} during the rollout is refused with HTTP 409. Body: ${JSON.stringify(body)}.`,
            `${what} during the rollout answered HTTP ${status}, not 409. Body: ${JSON.stringify(body)}.`,
          );
        };
        // Republish and rollback on android only: if the lock unexpectedly lets
        // one through, the ios rollout is still intact for the steps below.
        const republish = await requestRepublish(publishTarget, {
          platform: 'android',
          runtimeVersion,
          updateId: published.A.android.updateId,
          commitHash: commitHashOf('A'),
        });
        expectLocked('Republishing A (android)', republish.status, (await republish.text()).slice(0, 300));
        const rollback = await requestRollbackToEmbedded(publishTarget, {
          platform: 'android',
          runtimeVersion,
          commitHash: commitHashOf('rollback'),
        });
        expectLocked('A rollback to embedded (android)', rollback.status, (await rollback.text()).slice(0, 300));
        const rollouts = await readRollout(admin(), branch, runtimeVersion);
        recorder.expect(
          rollouts.length === PLATFORMS.length && rollouts.every((rollout) => rollout.percentage === 10),
          `The rollout is untouched afterwards: ${describeRollouts(rollouts)}.`,
          `The rollout changed during the refused calls: ${describeRollouts(rollouts)}.`,
        );
      },
    },
    {
      id: 'e',
      title: 'Raise the rollout to 25%, then 50%',
      needs: ['b'],
      run: async (recorder) => {
        for (const percentage of [25, 50]) {
          const { changed, after } = await countedWrite(`set ${percentage}%`, () =>
            setRolloutPercentage(admin(), target, percentage),
          );
          recorder.record(`set${percentage}`, { changed, after });
          recorder.expect(
            after.length === PLATFORMS.length && after.every((rollout) => rollout.percentage === percentage),
            `After set ${percentage}, a status read shows ${describeRollouts(after)}.`,
            `After set ${percentage}, a status read does not show every platform at ${percentage}%: ${describeRollouts(after)}.`,
          );
          if (!probesAnswerFromBranch || !canaryCohort) continue;
          const served = await probeCohort();
          for (const platform of PLATFORMS) {
            const now = new Set([...served[platform].entries()].filter(([, label]) => label === 'B').map(([id]) => id));
            const removed = [...canaryCohort[platform]].filter((id) => !now.has(id));
            recorder.observe(`${platform} at ${percentage}%: ${tally(served[platform])}.`);
            recorder.expect(
              removed.length === 0,
              `${platform} at ${percentage}%: every device that had B still has it. ${now.size - canaryCohort[platform].size} were added, none removed.`,
              `${platform} at ${percentage}%: ${removed.length} device(s) that had B were moved back to the control.`,
            );
            if (percentage === 50 && now.size === 0) {
              recorder.observe(
                `${platform}: no simulated device got B at 50%. With ${COHORT_SIZE} ids that is not chance: the server ` +
                  'is probably ignoring these client ids. Run again with --uuid-client-ids.',
              );
            }
            canaryCohort[platform] = now;
          }
        }
      },
    },
    {
      id: 'f',
      title: 'Read health for B and A',
      needs: ['b'],
      run: async (recorder) => {
        const health = await attempt(recorder, 'Rollout health', () =>
          readRolloutHealth(admin(), branch, runtimeVersion, healthPolicy),
        );
        recorder.record('rolloutHealth', health);
        // The UUIDs the finalize answers named, so both endpoints are still asked
        // (and their raw answers printed) when the lib could not read one of them.
        const knownUUIDs = (label: string): string[] =>
          PLATFORMS.flatMap((platform) => published[label]?.[platform].updateUUID ?? []);
        if (health === null && knownUUIDs('B').length > 0) {
          const updateUUIDs = [...knownUUIDs('B'), ...knownUUIDs('A')];
          await attempt(recorder, 'identity/update-health', () => admin().getUpdateHealth(updateUUIDs));
          await attempt(recorder, 'observe/update-health/history', () => admin().getUpdateHealthHistory(updateUUIDs));
        }
        for (const entry of health ?? []) {
          recorder.observe(
            `${entry.rollout.platform}: canary ${entry.canaryUpdateUUID ?? 'no UUID'} health is ` +
              `${entry.canary ? JSON.stringify(entry.canary) : 'absent from the answer'}; control ` +
              `${entry.controlUpdateUUID ?? 'no UUID'} health is ` +
              `${entry.control ? JSON.stringify(entry.control) : 'absent from the answer'}; newest history point is ` +
              `${entry.canaryIssues ? JSON.stringify(entry.canaryIssues) : 'absent'}. Verdict: ${entry.judgement.verdict}.`,
          );
          recorder.expect(
            entry.judgement.verdict === 'insufficient-evidence',
            `${entry.rollout.platform}: an update no device ran is judged insufficient-evidence, never healthy.`,
            `${entry.rollout.platform}: an update no device ran was judged ${entry.judgement.verdict}.`,
          );
        }
        const controlUUIDs = (health ?? []).flatMap((entry) => entry.controlUpdateUUID ?? []);
        const history =
          controlUUIDs.length > 0
            ? await attempt(recorder, 'The health history of A', () => admin().getUpdateHealthHistory(controlUUIDs))
            : null;
        if (history) {
          recorder.record('controlHistory', history);
          recorder.observe(
            `History for A: source ${JSON.stringify(history.source)}, ` +
              `${Object.keys(history.latest).length} of ${controlUUIDs.length} update(s) have a point.`,
          );
        }
        recorder.observe('The raw answers of both health endpoints are in the request list of this step.');
      },
    },
    {
      id: 'g',
      title: 'Revert the rollout',
      needs: ['b'],
      run: async (recorder) => {
        const { changed, after } = await countedWrite('revert', () => revertRollout(admin(), target));
        recorder.record('reverted', changed);
        if (after.length > 0) recorder.block(`A rollout is still live after revert: ${describeRollouts(after)}.`);
        recorder.pass('No rollout is active after revert.');
        const heads = await readHeads(recorder);
        for (const platform of heads ? PLATFORMS : []) {
          const head = heads?.[platform];
          if (!head) {
            recorder.fail(`${platform}: the update list has no head after revert.`);
            continue;
          }
          const details = await attempt(recorder, `${platform}: the details of update ${head.updateId}`, () =>
            admin().getUpdateDetails(branch, runtimeVersion, head.updateId),
          );
          recorder.record(`head-${platform}`, { listed: head, details });
          const isNew =
            !sameId(head.updateId, published.A[platform].updateId) &&
            !sameId(head.updateId, published.B[platform].updateId);
          recorder.observe(
            `${platform}: the head is now update ${head.updateId} (${isNew ? 'a new id, neither A nor B' : 'an existing id'}), ` +
              `updateUUID ${head.updateUUID ?? 'none'} (A was ${published.A[platform].updateUUID ?? 'unknown'}), ` +
              `message ${JSON.stringify(head.message)}, commitHash ${JSON.stringify(head.commitHash)} ` +
              `(A was published with ${commitHashOf('A')}), controlUpdateId ${head.controlUpdateId ?? 'none'}.`,
          );
        }
        if (probesAnswerFromBranch) {
          const anonymous = await probeAnonymous();
          for (const platform of PLATFORMS) {
            const answer = anonymous[platform];
            recorder.expect(
              answer.kind === 'update' && answer.launchHash === published.A[platform].bundleHash,
              `${platform}: devices are served A's bundle again (${labelOf(answer)}).`,
              `${platform}: after revert a device is served ${labelOf(answer)}, not A's bundle.`,
            );
          }
        }
        const unlocked = await publishSynthetic('C', null);
        if (unlocked.kind === 'published') recorder.pass('Publishing is unlocked: update C at 100% was accepted.');
        else {
          recorder.fail(
            `Publishing is still locked after revert: C was refused with HTTP ${unlocked.status} at ${unlocked.stage}.`,
          );
        }
      },
    },
    {
      id: 'h-start',
      title: 'Start a second rollout: update D at 10%',
      needs: ['a'],
      run: async (recorder) => {
        const updateD = await publishOrBlock(recorder, 'D', 10);
        const rollouts = await waitForRollout(true);
        if (rollouts.length === 0) recorder.block('No rollout is live after publishing D at 10%.');
        recorder.record('rollout', rollouts);
        for (const platform of PLATFORMS) {
          const live = rollouts.find((rollout) => rollout.platform === platform);
          recorder.expect(
            live !== undefined && sameId(live.updateId, updateD[platform].updateId) && live.percentage === 10,
            `${platform}: update D (${updateD[platform].updateId}) is rolling out at 10%, control ${live?.controlUpdateId ?? 'none'}.`,
            `${platform}: expected D at 10%, found ${live ? `${live.updateId} at ${live.percentage}%` : 'no rollout'}.`,
          );
        }
      },
    },
    {
      id: 'i',
      title: 'A write with the wrong expectedUpdateId',
      needs: ['h-start'],
      run: async (recorder) => {
        const before = await readRollout(admin(), branch, runtimeVersion);
        // An id no update has: ids are millisecond timestamps.
        const wrongAsString = '1';
        const wrongAsNumber = 1;
        const refusal = async (write: () => Promise<void>): Promise<number | null> => {
          try {
            await write();
            return null;
          } catch (error) {
            if (error instanceof XpremApiError) return error.status;
            throw error;
          }
        };
        const setStatus = await refusal(() =>
          admin().setUpdateRolloutPercentage(branch, runtimeVersion, 20, wrongAsString),
        );
        recorder.expect(
          setStatus !== null,
          `PUT …/rollout with a wrong expectedUpdateId (sent as a string) is refused with HTTP ${setStatus}.`,
          'PUT …/rollout with a wrong expectedUpdateId was ACCEPTED. The guard does not protect a write.',
        );
        const numberStatus = await refusal(() =>
          admin().setUpdateRolloutPercentage(branch, runtimeVersion, 20, wrongAsNumber),
        );
        recorder.observe(
          numberStatus === null
            ? 'The same wrong id sent as a JSON number was ACCEPTED.'
            : `The same wrong id sent as a JSON number is refused with HTTP ${numberStatus}. ` +
                (numberStatus === setStatus
                  ? 'Same status as the string form, so the server reads both types and compares them.'
                  : 'A different status from the string form, so the server refuses the type before comparing: ' +
                    'expectedUpdateId must be sent in the type the string form used.'),
        );
        const revertStatus = await refusal(() => admin().revertUpdateRollout(branch, runtimeVersion, wrongAsString));
        recorder.expect(
          revertStatus !== null,
          `POST …/rollout/revert with a wrong expectedUpdateId is refused with HTTP ${revertStatus}.`,
          'POST …/rollout/revert with a wrong expectedUpdateId was ACCEPTED.',
        );
        const after = await readRollout(admin(), branch, runtimeVersion);
        recorder.expect(
          describeRollouts(after) === describeRollouts(before) && after.length > 0,
          `The rollout is unchanged by the refused writes: ${describeRollouts(after)}.`,
          `The rollout changed: it was ${describeRollouts(before)} and is now ${describeRollouts(after)}.`,
        );
        const sentType = typeof before[0]?.updateId;
        recorder.observe(
          `The lib's own writes echo the id as the server serialised it in GET …/rollout, which is a ${sentType}.`,
        );
      },
    },
    {
      id: 'h-finish',
      title: 'Finish the second rollout',
      needs: ['h-start'],
      run: async (recorder) => {
        const { changed, after } = await countedWrite('finish', () => setRolloutPercentage(admin(), target, 100));
        recorder.record('finished', changed);
        if (after.length > 0) recorder.block(`A rollout is still live after finish: ${describeRollouts(after)}.`);
        recorder.pass('No rollout is active after finish.');
        const heads = await readHeads(recorder);
        for (const platform of heads ? PLATFORMS : []) {
          const head = heads?.[platform];
          recorder.expect(
            head !== undefined && sameId(head.updateId, published.D[platform].updateId),
            `${platform}: D is the head in the admin API (rolloutPercentage ${head?.rolloutPercentage ?? 'none'}, controlUpdateId ${head?.controlUpdateId ?? 'none'}).`,
            `${platform}: the head is ${head ? head.updateId : 'missing'}, not D (${published.D[platform].updateId}).`,
          );
        }
        if (probesAnswerFromBranch) {
          const anonymous = await probeAnonymous();
          const served = await probeCohort();
          for (const platform of PLATFORMS) {
            const everyone = [labelOf(anonymous[platform]), ...served[platform].values()];
            recorder.expect(
              everyone.every((label) => label === 'D'),
              `${platform}: the anonymous request and all ${COHORT_SIZE} simulated devices are served D.`,
              `${platform}: not everyone is served D after finish: anonymous got ${everyone[0]}; ${tally(served[platform])}.`,
            );
          }
        }
        const unlocked = await publishSynthetic('E', null);
        if (unlocked.kind === 'published') recorder.pass('Publishing is unlocked: update E at 100% was accepted.');
        else {
          recorder.fail(
            `Publishing is still locked after finish: E was refused with HTTP ${unlocked.status} at ${unlocked.stage}.`,
          );
        }
      },
    },
    {
      id: 'j',
      title: 'One write, or one per platform',
      run: async (recorder) => {
        if (writeCalls.length === 0) {
          recorder.observe('No rollout write ran, so there is nothing to conclude.');
          return;
        }
        recorder.record('writeCalls', writeCalls);
        for (const write of writeCalls) {
          recorder.observe(
            `${write.operation}: ${write.platformsBefore} platform(s) were rolling out, the lib sent ${write.calls} ` +
              `write request(s), and afterwards the server showed ${write.platformsAfter}.`,
          );
        }
        const oneCallMovedAll = writeCalls.every((write) => write.calls === 1 && write.platformsBefore > 1);
        recorder.observe(
          oneCallMovedAll
            ? 'One PUT or revert acted on every platform that shares the runtime version: the lib wrote once and ' +
                'found the other platform already done. The write is addressed by branch and runtime version, with ' +
                'no platform in it.'
            : 'The lib needed more than one write for two platforms on one runtime version, so a write did not act ' +
                'on both. See the per-operation lines above.',
        );
        recorder.observe(
          'For production: iOS and Android resolve different fingerprints, so they are on different runtime ' +
            'versions and each needs its own call. That is what scripts/mobile-ota-rollout.ts already does (one ' +
            '--runtime-version per run) and what mobile-ota-unlock.yml does (one revert per platform).' +
            (oneCallMovedAll
              ? ' And where two platforms do share a runtime version, --platform ios cannot move ios alone: the ' +
                'server moves both.'
              : ''),
        );
      },
    },
  ];

  let results: StepResult[];
  try {
    results = await runSteps(steps, proofFetch.takeExchanges, mask);
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
  return {
    server: base.origin,
    branch,
    runtimeVersion,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    clientIdKind: options.uuidClientIds === true ? 'uuid' : 'non-uuid',
    steps: results,
    ok: results.every((step) => step.outcome !== 'FAIL'),
  };
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

const compact = (body: unknown): string => {
  if (body === null || body === undefined || body === '') return '';
  const serialised = typeof body === 'string' ? body : JSON.stringify(body);
  return serialised.length > 700 ? `${serialised.slice(0, 700)}…` : serialised;
};

/** The first finding of the step's outcome, as the one-line reason in the summary table. */
function headline(step: StepResult): string {
  if (step.skippedBecause !== null) return step.skippedBecause;
  const finding = step.findings.find((candidate) => candidate.outcome === step.outcome) ?? step.findings[0];
  const text = finding?.text ?? '';
  return (text.length > 160 ? `${text.slice(0, 160)}…` : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function formatTranscript(report: ProofReport): string {
  const lines = [
    '# OTA rollout proof',
    '',
    `- Server: \`${report.server}\``,
    `- Branch: \`${report.branch}\``,
    `- Runtime version: \`${report.runtimeVersion}\` (synthetic; no binary has it)`,
    `- Simulated device ids: ${report.clientIdKind === 'uuid' ? 'random UUIDs (registered by Observe as devices)' : 'non-UUID strings (not registered by Observe)'}`,
    `- Started ${report.startedAt}, finished ${report.finishedAt}`,
    `- Result: ${report.ok ? 'no step failed' : 'at least one step FAILED'}`,
    '',
    '## Summary',
    '',
    '| Step | Outcome | First finding |',
    '| --- | --- | --- |',
    ...report.steps.map((step) => `| ${step.id}. ${step.title} | ${step.outcome} | ${headline(step)} |`),
    '',
  ];
  for (const step of report.steps) {
    lines.push(`## ${step.id}. ${step.title}`, '', `**${step.outcome}**`, '');
    if (step.skippedBecause !== null) lines.push(`- SKIPPED: ${step.skippedBecause}.`);
    for (const finding of step.findings) lines.push(`- ${finding.outcome}: ${finding.text}`);
    if (step.exchanges.length > 0) {
      lines.push('', 'Requests:', '', '```');
      for (const exchange of step.exchanges) {
        const times = exchange.count > 1 ? ` (x${exchange.count})` : '';
        const body = compact(exchange.body);
        lines.push(`${exchange.method} ${exchange.path}${times} -> ${exchange.status}${body ? `  ${body}` : ''}`);
      }
      lines.push('```');
    }
    lines.push('');
  }
  lines.push(
    '## What this run left on the server',
    '',
    `- The branch \`${report.branch}\` remains, with the runtime version \`${report.runtimeVersion}\` and the ` +
      "synthetic updates published to it. Nothing was deleted. Deleting the branch is the owner's call " +
      '(dashboard, Branches).',
    '- Its update folders live under the `pr-` storage prefix, which the bucket lifecycle rule expires after 14 ' +
      "days. The bundles themselves are a few bytes each in the app's content-addressed store, and any bundle " +
      'patches the server computed between them are under `bsdiff/`. That rule covers neither.',
    '- No channel was remapped, Branch Surfing was read and not changed, and no other branch was written to.',
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseProofArgs(argv: string[]): { branch: string; outDir: string; uuidClientIds: boolean } {
  let branch = ROLLOUT_PROOF_BRANCH;
  let outDir = 'ota-rollout-proof-out';
  let uuidClientIds = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--uuid-client-ids') {
      uuidClientIds = true;
      continue;
    }
    if (argument !== '--branch' && argument !== '--out-dir') throw new Error(`Unknown argument: ${argument}.`);
    const flagInput = argv[++index];
    if (!flagInput || flagInput.startsWith('--')) throw new Error(`${argument} needs a value.`);
    if (argument === '--branch') branch = flagInput;
    else outDir = flagInput;
  }
  return { branch, outDir, uuidClientIds };
}

async function main(): Promise<void> {
  const args = parseProofArgs(process.argv.slice(2));
  // Before the environment is read: a wrong branch must not get as far as a credential.
  assertProofBranch(args.branch, desiredOtaState);
  const manifestUrl = process.env.EXPO_UPDATES_URL ?? '';
  if (!manifestUrl) throw new Error('Set EXPO_UPDATES_URL (the manifest endpoint of the update server).');
  const report = await runRolloutProof({
    manifestUrl,
    adminEmail: process.env.OTA_ADMIN_EMAIL ?? '',
    adminPassword: process.env.OTA_ADMIN_PASSWORD ?? '',
    publishToken: process.env.EOO_TOKEN ?? '',
    branch: args.branch,
    uuidClientIds: args.uuidClientIds,
  });
  const transcript = formatTranscript(report);
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'transcript.md'), transcript);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, transcript);
    for (const step of report.steps) console.log(`${LOG} ${step.outcome.padEnd(8)} ${step.id}. ${step.title}`);
  } else {
    console.log(transcript);
  }
  console.log(`${LOG} Result and transcript written to ${outDir}.`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // The email and password never reach an error of ours, but a server answer
    // can quote a request back. Mask whatever is about to be printed.
    const mask = createMasker([process.env.OTA_ADMIN_EMAIL, process.env.OTA_ADMIN_PASSWORD, process.env.EOO_TOKEN]);
    console.error(`${LOG} ${mask(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  });
}
