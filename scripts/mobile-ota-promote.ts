/// <reference types="node" />

/**
 * Promote the archived, already-exported main OTA to the existing production branch.
 * xprem cannot republish across branches. This speaks the same upload/finalize
 * protocol as eoas@3.2.4, but never runs Expo export again. That protocol changed
 * at 3.2.0: requestUploadUrl takes a `files` list (path, content hash, md5 cache
 * key and role) instead of `fileNames`, and a server on either side of that line
 * rejects the other shape, so this file moves with EOAS_PACKAGE_SPEC. The pipeline must first
 * verify that the staged commit's GraphQL schema is live.
 *
 * vp exec tsx scripts/mobile-ota-promote.ts --receipt ota-stage/receipt.json \
 *   --ios-export ota-stage/ios --android-export ota-stage/android
 *
 * `--branch <name>` (default `production`) promotes to another branch of the same
 * channel, and `--capture-baseline` takes the same flag. The channel is always
 * `production`: it is baked into every binary, and a device reaches another
 * branch only through the `xprem-branch` header.
 *
 * `--rollout-percentage <1-99> --rollout-receipt <path>` starts the update as a
 * rollout to that share of devices. A rollout cannot be confirmed through the
 * anonymous manifest, which serves one device's view, so this mode reads the
 * rollout itself and needs the admin login (`OTA_ADMIN_EMAIL`,
 * `OTA_ADMIN_PASSWORD`) next to `EOO_TOKEN`. For the same reason it does NOT run
 * the served-bytes check the default mode ends with: it confirms that the leased
 * update is rolling out, and the bytes are covered only by the content hashes
 * the server validated at upload.
 *
 * It is safe to re-run. The update ids it was leased are written to the rollout
 * receipt, and a platform whose live rollout carries its recorded id (and its
 * commit) counts as done. Any other live rollout is refused.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_BRANCH,
  UPDATE_ID,
  UUID,
  buildUploadFiles,
  finalizeUpload,
  object,
  parseServedManifest,
  parseUploadLease,
  requestManifest,
  requestUploadLease,
  requireSuccess,
  sentenceLabel,
  sleep,
  string,
  uploadLeaseFiles,
  uploadServerBase,
  validateExport,
} from './lib/ota-publish-protocol.ts';
import type { OtaPlatform, PublishTarget, UploadLease, ValidatedExport } from './lib/ota-publish-protocol.ts';
import { adminClientFromEnvironment, sameId } from './lib/xprem-admin.mts';
import type { XpremAdminClient, XpremId } from './lib/xprem-admin.mts';

export { validateExport };

export interface StageReceipt {
  commitHash: string;
  message: string;
  platforms: Record<OtaPlatform, { runtimeVersion: string; bundleSha256: string }>;
  baselineProductionUpdateIds: Record<OtaPlatform, string | null>;
}

const SHA256 = /^[0-9a-f]{64}$/i;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function branchName(input: string): string {
  if (!BRANCH_NAME.test(input)) throw new Error(`Invalid branch name: ${JSON.stringify(input)}.`);
  return input;
}

/** What rollout mode reads from the admin API. */
export type RolloutReader = Pick<XpremAdminClient, 'getUpdateRollout' | 'getUpdateDetails'>;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export function parseStageReceipt(input: unknown): StageReceipt {
  const raw = object(input, 'Stage receipt');
  const commitHash = string(raw.commitHash, 'Stage commitHash');
  if (!COMMIT_SHA.test(commitHash)) throw new Error('Stage commitHash must be a 40-character SHA.');
  const message = string(raw.message, 'Stage message');
  const platforms = object(raw.platforms, 'Stage platforms');
  const parsedPlatforms = {} as StageReceipt['platforms'];
  for (const platform of ['ios', 'android'] as const) {
    const entry = object(platforms[platform], `Stage ${platform}`);
    const runtimeVersion = string(entry.runtimeVersion, `${platform} runtimeVersion`);
    const bundleSha256 = string(entry.bundleSha256, `${platform} bundleSha256`);
    if (!/^[0-9a-f]{40}$/i.test(runtimeVersion))
      throw new Error(`${platform} runtimeVersion must be a fingerprint SHA.`);
    if (!SHA256.test(bundleSha256)) throw new Error(`${platform} bundleSha256 must be a SHA-256 digest.`);
    parsedPlatforms[platform] = { runtimeVersion, bundleSha256 };
  }
  const baseline = object(raw.baselineProductionUpdateIds, 'Stage baselineProductionUpdateIds');
  const baselineProductionUpdateIds = {} as StageReceipt['baselineProductionUpdateIds'];
  for (const platform of ['ios', 'android'] as const) {
    const updateId = baseline[platform];
    if (updateId !== null && (typeof updateId !== 'string' || !UPDATE_ID.test(updateId))) {
      throw new Error(`${platform} baseline production update ID must be a UUID-shaped ID or null.`);
    }
    baselineProductionUpdateIds[platform] = updateId;
  }
  return { commitHash, message, platforms: parsedPlatforms, baselineProductionUpdateIds };
}

export function parsePromoteArgs(argv: string[]): {
  receipt: string;
  iosExport: string;
  androidExport: string;
  branch: string;
  rolloutPercentage: number | null;
  rolloutReceipt: string | null;
} {
  const pathFlags = ['--receipt', '--ios-export', '--android-export', '--rollout-receipt'];
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--') continue;
    if (![...pathFlags, '--branch', '--rollout-percentage'].includes(flag))
      throw new Error(`Unknown argument: ${flag}.`);
    const argument = argv[++index];
    if (!argument || argument.startsWith('--'))
      throw new Error(`${flag} needs a ${pathFlags.includes(flag) ? 'path' : 'value'}.`);
    args[flag] = argument;
  }
  if (!args['--receipt'] || !args['--ios-export'] || !args['--android-export']) {
    throw new Error('Provide --receipt, --ios-export, and --android-export.');
  }
  let rolloutPercentage: number | null = null;
  if (args['--rollout-percentage'] !== undefined) {
    rolloutPercentage = Number(args['--rollout-percentage']);
    if (!Number.isInteger(rolloutPercentage) || rolloutPercentage < 1 || rolloutPercentage > 99) {
      throw new Error('--rollout-percentage must be a whole number from 1 to 99.');
    }
  }
  const rolloutReceipt = args['--rollout-receipt'] ?? null;
  if ((rolloutPercentage === null) !== (rolloutReceipt === null)) {
    throw new Error('--rollout-percentage and --rollout-receipt go together.');
  }
  return {
    receipt: args['--receipt'],
    iosExport: args['--ios-export'],
    androidExport: args['--android-export'],
    branch: branchName(args['--branch'] ?? DEFAULT_BRANCH),
    rolloutPercentage,
    rolloutReceipt,
  };
}

export function parseCaptureArgs(argv: string[]): {
  appId: string;
  iosRuntime: string;
  androidRuntime: string;
  out: string;
  branch: string;
} {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--capture-baseline') continue;
    if (!['--app-id', '--ios-runtime', '--android-runtime', '--out', '--branch'].includes(flag)) {
      throw new Error(`Unknown capture argument: ${flag}.`);
    }
    const argument = argv[++index];
    if (!argument || argument.startsWith('--')) throw new Error(`${flag} needs a value.`);
    args[flag] = argument;
  }
  const appId = args['--app-id'];
  const iosRuntime = args['--ios-runtime'];
  const androidRuntime = args['--android-runtime'];
  const out = args['--out'];
  if (!appId || !UUID.test(appId)) throw new Error('--app-id must be a UUID.');
  if (!iosRuntime || !/^[0-9a-f]{40}$/i.test(iosRuntime)) throw new Error('--ios-runtime must be a fingerprint SHA.');
  if (!androidRuntime || !/^[0-9a-f]{40}$/i.test(androidRuntime))
    throw new Error('--android-runtime must be a fingerprint SHA.');
  if (!out) throw new Error('--out is required.');
  return { appId, iosRuntime, androidRuntime, out, branch: branchName(args['--branch'] ?? DEFAULT_BRANCH) };
}

async function readProductionManifest(
  manifestUrl: string,
  platform: OtaPlatform,
  runtimeVersion: string,
  appId: string,
  fetchImpl: typeof fetch,
  branch: string,
): Promise<Record<string, unknown> | null> {
  const response = await requestManifest({ manifestUrl, platform, runtimeVersion, appId, branch, fetchImpl });
  await requireSuccess(response, `${platform} ${branch} manifest probe`);
  const manifest = parseServedManifest(await response.text(), branch);
  if (manifest === null) return null;
  if (manifest.runtimeVersion !== runtimeVersion)
    throw new Error(`${platform} ${branch} runtimeVersion differs from staged runtime.`);
  const extra = object(manifest.extra, `${sentenceLabel(branch)} manifest extra`);
  if (extra.branch !== branch) throw new Error(`${platform} manifest is not from the ${branch} branch.`);
  return manifest;
}

async function productionUpdateId(
  manifestUrl: string,
  platform: OtaPlatform,
  runtimeVersion: string,
  appId: string,
  fetchImpl: typeof fetch,
  branch: string,
): Promise<string | null> {
  const manifest = await readProductionManifest(manifestUrl, platform, runtimeVersion, appId, fetchImpl, branch);
  if (manifest === null) return null;
  const id = string(manifest.id, `${platform} ${branch} update ID`);
  if (!UPDATE_ID.test(id)) throw new Error(`${platform} ${branch} update ID must be a UUID-shaped ID.`);
  return id;
}

export async function captureProductionBaseline(options: {
  manifestUrl: string;
  appId: string;
  runtimeVersions: Record<OtaPlatform, string>;
  /** The branch whose served update is the baseline. Defaults to `production`. */
  branch?: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<OtaPlatform, string | null>> {
  if (!UUID.test(options.appId)) throw new Error('Capture app ID must be a UUID.');
  uploadServerBase(options.manifestUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const branch = branchName(options.branch ?? DEFAULT_BRANCH);
  const baseline = {} as Record<OtaPlatform, string | null>;
  for (const platform of ['ios', 'android'] as const) {
    const runtimeVersion = options.runtimeVersions[platform];
    if (!/^[0-9a-f]{40}$/i.test(runtimeVersion)) throw new Error(`${platform} capture runtimeVersion is invalid.`);
    baseline[platform] = await productionUpdateId(
      options.manifestUrl,
      platform,
      runtimeVersion,
      options.appId,
      fetchImpl,
      branch,
    );
  }
  return baseline;
}

async function verifyServedExport(
  manifestUrl: string,
  exportFiles: ValidatedExport,
  runtimeVersion: string,
  fetchImpl: typeof fetch,
  branch: string,
): Promise<void> {
  const manifest = await readProductionManifest(
    manifestUrl,
    exportFiles.platform,
    runtimeVersion,
    exportFiles.appId,
    fetchImpl,
    branch,
  );
  if (manifest === null) throw new Error(`${exportFiles.platform} ${branch} has no update after promotion.`);
  const extra = object(manifest.extra, `${sentenceLabel(branch)} manifest extra`);
  if (!isDeepStrictEqual(extra.expoClient, exportFiles.expoConfig)) {
    throw new Error(`${exportFiles.platform} ${branch} Expo config differs from stage.`);
  }
  const launchAsset = object(manifest.launchAsset, `${sentenceLabel(branch)} launchAsset`);
  const bundleFile = exportFiles.files.get(exportFiles.bundlePath);
  if (!bundleFile) throw new Error(`${exportFiles.platform} export bundle disappeared.`);
  const bundleHash = createHash('sha256').update(readFileSync(bundleFile.absolutePath)).digest('base64url');
  if (launchAsset.hash !== bundleHash)
    throw new Error(`${exportFiles.platform} ${branch} bundle hash differs from stage.`);
  if (!Array.isArray(manifest.assets)) throw new Error(`${exportFiles.platform} ${branch} manifest has no asset list.`);
  const servedHashes = manifest.assets
    .map((assetInput: unknown) =>
      string(object(assetInput, `${sentenceLabel(branch)} asset`).hash, `${sentenceLabel(branch)} asset hash`),
    )
    .sort();
  const stagedHashes = exportFiles.assetPaths
    .map((assetPath) => {
      const asset = exportFiles.files.get(assetPath);
      if (!asset) throw new Error(`${exportFiles.platform} staged asset disappeared: ${assetPath}.`);
      return createHash('sha256').update(readFileSync(asset.absolutePath)).digest('base64url');
    })
    .sort();
  if (JSON.stringify(servedHashes) !== JSON.stringify(stagedHashes)) {
    throw new Error(`${exportFiles.platform} ${branch} asset hashes differ from stage.`);
  }
}

async function verifyServedExportWithRetry(
  manifestUrl: string,
  exportFiles: ValidatedExport,
  runtimeVersion: string,
  fetchImpl: typeof fetch,
  delaysMs: readonly number[],
  branch: string,
): Promise<void> {
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      await verifyServedExport(manifestUrl, exportFiles, runtimeVersion, fetchImpl, branch);
      return;
    } catch (error) {
      if (attempt === delaysMs.length) throw error;
      console.warn(`[ota-promote] ${exportFiles.platform}: ${branch} manifest not yet confirmed; retrying.`);
      await sleep(delaysMs[attempt]);
    }
  }
}

/** What an earlier run of this promotion left in its rollout receipt. */
interface RolloutRecord {
  /** The numeric update id the server leased, per platform. */
  updateIds: Partial<Record<OtaPlatform, string>>;
  /**
   * The update each platform's rollout replaced: the staged baseline at the
   * moment the lease was taken, as a manifest id (the update UUID), or null when
   * the runtime version had no update yet. This is the rollout's control.
   */
  baselineUpdateIds: Partial<Record<OtaPlatform, string | null>>;
}

/**
 * The rollout receipt of an earlier run. Empty when there is no file yet, or
 * when the file belongs to another commit or branch: ids from a different
 * promotion prove nothing about this one.
 */
function readRolloutReceipt(path: string, branch: string, receipt: StageReceipt): RolloutRecord {
  const record: RolloutRecord = { updateIds: {}, baselineUpdateIds: {} };
  if (!existsSync(path)) return record;
  const receiptJson = object(JSON.parse(readFileSync(path, 'utf8')) as unknown, 'Rollout receipt');
  if (receiptJson.branch !== branch || receiptJson.commitHash !== receipt.commitHash) return record;
  const updateIds = object(receiptJson.updateIds, 'Rollout receipt updateIds');
  const baselineUpdateIds = object(receiptJson.baselineUpdateIds, 'Rollout receipt baselineUpdateIds');
  for (const platform of ['ios', 'android'] as const) {
    const updateId = updateIds[platform];
    if (updateId === undefined) continue;
    if (typeof updateId !== 'string' || !/^\d+$/.test(updateId)) {
      throw new Error(`Rollout receipt ${platform} update id is not a numeric id.`);
    }
    const baselineUpdateId = baselineUpdateIds[platform];
    if (baselineUpdateId !== null && (typeof baselineUpdateId !== 'string' || !UPDATE_ID.test(baselineUpdateId))) {
      throw new Error(`Rollout receipt ${platform} baseline update id must be a UUID-shaped ID or null.`);
    }
    record.updateIds[platform] = updateId;
    record.baselineUpdateIds[platform] = baselineUpdateId;
  }
  return record;
}

export async function promoteArchivedOta(options: {
  receiptPath: string;
  iosExport: string;
  androidExport: string;
  manifestUrl: string;
  token: string;
  /** The branch to promote to. Defaults to `production`. */
  branch?: string;
  /**
   * Start the update as a rollout to this share of devices instead of publishing
   * it to everyone. `connect` opens the admin API for the app the exports name,
   * which is how the rollout is confirmed. `receiptPath` is a small JSON file
   * this writes the leased update ids to, and reads on a re-run to recognise its
   * own rollout; keep it with the stage receipt between attempts.
   */
  rollout?: { percentage: number; receiptPath: string; connect: (appId: string) => Promise<RolloutReader> };
  fetchImpl?: typeof fetch;
  verificationDelaysMs?: readonly number[];
}): Promise<void> {
  if (!options.token) throw new Error('EOO_TOKEN is required.');
  const branch = branchName(options.branch ?? DEFAULT_BRANCH);
  const rolloutPercentage = options.rollout?.percentage ?? null;
  if (
    rolloutPercentage !== null &&
    (!Number.isInteger(rolloutPercentage) || rolloutPercentage < 1 || rolloutPercentage > 99)
  ) {
    throw new Error('A rollout percentage must be a whole number from 1 to 99.');
  }
  const receipt = parseStageReceipt(JSON.parse(readFileSync(options.receiptPath, 'utf8')) as unknown);
  const exports = {
    ios: validateExport(options.iosExport, 'ios', receipt.platforms.ios.bundleSha256),
    android: validateExport(options.androidExport, 'android', receipt.platforms.android.bundleSha256),
  };
  if (exports.ios.appId !== exports.android.appId)
    throw new Error('iOS and Android exports have different expo-app-id values.');
  const appId = exports.ios.appId;
  const base = uploadServerBase(options.manifestUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const target: PublishTarget = { base, appId, branch, token: options.token, fetchImpl };
  const verificationDelaysMs = options.verificationDelaysMs ?? [1_000, 2_000, 4_000, 8_000];
  const rolloutReader = options.rollout ? await options.rollout.connect(appId) : null;
  const publishGroup = randomUUID();
  // null: the server answered 406, so the branch already serves exactly these files.
  // 'rolling': rollout mode found this platform's own rollout already live.
  const leases = {} as Record<OtaPlatform, UploadLease | null | 'rolling'>;
  let lastUploadStart = 0;
  const paceUpload = async (): Promise<void> => {
    // Match this repo's eoas --upload-rate 5 setting, including retry attempts.
    const remainingMs = lastUploadStart + 200 - Date.now();
    if (remainingMs > 0) await sleep(remainingMs);
    lastUploadStart = Date.now();
  };

  const assertBaselineUnchanged = async (platform: OtaPlatform): Promise<void> => {
    const expected = receipt.baselineProductionUpdateIds[platform];
    const current = await productionUpdateId(
      options.manifestUrl,
      platform,
      receipt.platforms[platform].runtimeVersion,
      appId,
      fetchImpl,
      branch,
    );
    if (current !== expected) {
      throw new Error(
        `${platform} ${branch} update changed since staging began ` +
          `(baseline ${expected ?? 'none'}, current ${current ?? 'none'}); refusing stale OTA promotion.`,
      );
    }
  };

  // What an earlier run of the same commit to the same branch was leased, and
  // which update each of its rollouts replaced.
  const rolloutRecord: RolloutRecord = options.rollout
    ? readRolloutReceipt(options.rollout.receiptPath, branch, receipt)
    : { updateIds: {}, baselineUpdateIds: {} };
  const recordLease = (platform: OtaPlatform, updateId: string): void => {
    if (!options.rollout) return;
    rolloutRecord.updateIds[platform] = updateId;
    // The lease is only requested after the baseline was confirmed unchanged, so
    // the staged baseline is the update this rollout is about to replace.
    rolloutRecord.baselineUpdateIds[platform] = receipt.baselineProductionUpdateIds[platform];
    writeFileSync(
      options.rollout.receiptPath,
      `${JSON.stringify({ branch, commitHash: receipt.commitHash, ...rolloutRecord })}\n`,
    );
  };

  /**
   * A re-run cannot ask "is the branch unchanged since staging?" about a
   * platform whose own rollout is live: this promotion changed it, and the
   * anonymous manifest shows one device's side of the rollout. The question that
   * replaces it is "did my rollout replace the update I staged against?". The
   * server names the update a rollout replaced (its control), and the receipt
   * recorded the baseline when the lease was taken, so the two must be the same
   * update. If they are not, something else was published in between and this
   * rollout is not the one that was staged and tested.
   */
  const assertRolloutReplacedBaseline = async (
    reader: RolloutReader,
    platform: OtaPlatform,
    live: { updateId: XpremId; controlUpdateId: XpremId | null },
  ): Promise<void> => {
    const runtimeVersion = receipt.platforms[platform].runtimeVersion;
    const recordedBaseline = rolloutRecord.baselineUpdateIds[platform] ?? null;
    const controlUpdateUUID =
      live.controlUpdateId === null
        ? null
        : (await reader.getUpdateDetails(branch, runtimeVersion, live.controlUpdateId)).updateUUID;
    if (live.controlUpdateId !== null && controlUpdateUUID === null) {
      throw new Error(
        `${platform} ${branch} rollout ${live.updateId} replaced update ${live.controlUpdateId}, which the server ` +
          'cannot identify; refusing to treat the rollout as the staged one.',
      );
    }
    if ((controlUpdateUUID ?? '').toLowerCase() !== (recordedBaseline ?? '').toLowerCase()) {
      throw new Error(
        `${platform} ${branch} rollout ${live.updateId} replaced ${controlUpdateUUID ?? 'no update'}, not the staged ` +
          `baseline ${recordedBaseline ?? 'none'}; refusing to treat the rollout as the staged one.`,
      );
    }
  };

  /**
   * Rollout mode's answer to "is the rollout that is live on this platform mine?".
   * False when none is live. Throws when one is live and cannot be shown to be
   * this promotion's, because nothing can be published over it.
   *
   * "Mine" needs the numeric update id the server leased to this promotion: the
   * lease in hand, or on a re-run the id an earlier run wrote to the rollout
   * receipt. A re-run additionally checks the commit the live update was built
   * from, and that the rollout replaced the staged baseline. The commit alone is
   * never enough: the update details expose no content hash, and two different
   * exports can share a commit.
   */
  const ownRolloutIsLive = async (
    reader: RolloutReader,
    platform: OtaPlatform,
    leaseUpdateId: string | null,
  ): Promise<boolean> => {
    const runtimeVersion = receipt.platforms[platform].runtimeVersion;
    const rollout = await reader.getUpdateRollout(branch, runtimeVersion);
    const live = rollout.active ? rollout.updates.find((update) => update.platform === platform) : undefined;
    if (!live) return false;
    const expectedUpdateId = leaseUpdateId ?? rolloutRecord.updateIds[platform] ?? null;
    let own = expectedUpdateId !== null && sameId(live.updateId, expectedUpdateId);
    if (own && leaseUpdateId === null) {
      const details = await reader.getUpdateDetails(branch, runtimeVersion, live.updateId);
      own = details.commitHash?.toLowerCase() === receipt.commitHash.toLowerCase();
    }
    if (!own) {
      throw new Error(
        `${platform} ${branch} has an active rollout of another update (${live.updateId}); promotion was refused.`,
      );
    }
    // With a lease in hand the baseline was checked against the manifest moments
    // ago, before the first upload. Without one this is the only baseline check.
    if (leaseUpdateId === null) await assertRolloutReplacedBaseline(reader, platform, live);
    console.log(
      `[ota-promote] ${platform}: update ${live.updateId} is rolling out to ${live.percentage}% on ${branch}.`,
    );
    return true;
  };

  const confirmRolloutStarted = async (
    reader: RolloutReader,
    platform: OtaPlatform,
    leaseUpdateId: string,
  ): Promise<void> => {
    for (let attempt = 0; attempt <= verificationDelaysMs.length; attempt++) {
      if (await ownRolloutIsLive(reader, platform, leaseUpdateId)) return;
      if (attempt === verificationDelaysMs.length) {
        throw new Error(`${platform} ${branch} shows no rollout for update ${leaseUpdateId} after promotion.`);
      }
      console.warn(`[ota-promote] ${platform}: ${branch} rollout not yet confirmed; retrying.`);
      await sleep(verificationDelaysMs[attempt]);
    }
  };

  // Rollout mode first asks whether a platform's own rollout is already live: a
  // re-run after a partial failure must not publish the same bytes a second time.
  // Such a platform skips the manifest baseline check below on purpose, and gets
  // assertRolloutReplacedBaseline in its place: see there for why.
  for (const platform of ['ios', 'android'] as const) {
    if (rolloutReader && (await ownRolloutIsLive(rolloutReader, platform, null))) leases[platform] = 'rolling';
  }

  // Both platforms must still match their pre-stage baseline before creating
  // either production upload lease. A no-update directive is an explicit null;
  // malformed responses and rollback directives are never treated as null.
  if (leases.ios !== 'rolling') await assertBaselineUnchanged('ios');
  if (leases.android !== 'rolling') await assertBaselineUnchanged('android');

  // Validate both server responses before sending any archived bytes.
  for (const platform of ['ios', 'android'] as const) {
    if (leases[platform] === 'rolling') continue;
    const response = await requestUploadLease(target, {
      platform,
      runtimeVersion: receipt.platforms[platform].runtimeVersion,
      commitHash: receipt.commitHash,
      publishGroup,
      rolloutPercentage,
      files: buildUploadFiles(exports[platform]),
      message: receipt.message,
    });
    if (response.status === 409) {
      // A rollout started between the check above and this request. Mine is
      // success; anyone else's throws inside ownRolloutIsLive.
      if (rolloutReader && (await ownRolloutIsLive(rolloutReader, platform, null))) {
        await response.body?.cancel();
        leases[platform] = 'rolling';
        continue;
      }
      throw new Error(`${platform} ${branch} has an active rollout; promotion was refused.`);
    }
    if (response.status === 406) {
      if (rolloutReader) {
        throw new Error(`${platform} ${branch} already serves these files to everyone; there is no rollout to start.`);
      }
      // Since 3.2.0 "no changes" is answered here, before any upload. The served
      // manifest is still verified below, so this cannot hide a wrong update.
      await response.body?.cancel();
      leases[platform] = null;
      continue;
    }
    await requireSuccess(response, `${platform} upload request`);
    const leaseInput = (await response.json()) as unknown;
    // An old server ignores unknown query parameters, so a lease that does not
    // echo the percentage means finalizing it would publish to every device.
    // Stop before a byte is uploaded (eoas 3.2.5 makes the same check).
    if (rolloutPercentage !== null && object(leaseInput, 'Upload lease').rolloutPercentage === undefined) {
      throw new Error(`${platform} upload lease ignored the rollout percentage; refusing a full publish.`);
    }
    const lease = parseUploadLease(leaseInput, exports[platform].files, base, appId);
    // Written before a byte is uploaded: if this run dies after finalize, the
    // next one still knows which update id was its own.
    recordLease(platform, lease.updateId);
    leases[platform] = lease;
  }

  for (const platform of ['ios', 'android'] as const) {
    const lease = leases[platform];
    if (lease === 'rolling') continue;
    if (lease === null) {
      console.log(`[ota-promote] ${platform}: ${branch} already serves these files; verifying only.`);
    } else {
      // Recheck immediately before each platform's first production PUT.
      await assertBaselineUnchanged(platform);
      await uploadLeaseFiles(lease, exports[platform], target, paceUpload);
      const response = await finalizeUpload(target, {
        platform,
        runtimeVersion: receipt.platforms[platform].runtimeVersion,
        updateId: lease.updateId,
      });
      if (response.status === 409) {
        // In rollout mode a retried finalize can meet the rollout its own first
        // attempt started. The lease id says exactly whose it is.
        if (!rolloutReader || !(await ownRolloutIsLive(rolloutReader, platform, lease.updateId))) {
          throw new Error(`${platform} ${branch} has an active rollout; promotion was refused.`);
        }
      } else if (response.status !== 406) {
        await requireSuccess(response, `${platform} ${branch} finalize`);
      }
    }
    if (rolloutReader && lease !== null) {
      await confirmRolloutStarted(rolloutReader, platform, lease.updateId);
      console.log(
        `[ota-promote] ${platform}: archived bundle ${receipt.platforms[platform].bundleSha256} ` +
          `rolling out to ${rolloutPercentage}% on ${branch}.`,
      );
      continue;
    }
    await verifyServedExportWithRetry(
      options.manifestUrl,
      exports[platform],
      receipt.platforms[platform].runtimeVersion,
      fetchImpl,
      verificationDelaysMs,
      branch,
    );
    console.log(`[ota-promote] ${platform}: archived bundle ${receipt.platforms[platform].bundleSha256} promoted.`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--capture-baseline')) {
    const args = parseCaptureArgs(process.argv.slice(2));
    const baseline = await captureProductionBaseline({
      manifestUrl: process.env.EXPO_UPDATES_URL ?? '',
      appId: args.appId,
      runtimeVersions: { ios: args.iosRuntime, android: args.androidRuntime },
      branch: args.branch,
    });
    writeFileSync(args.out, `${JSON.stringify(baseline)}\n`, { flag: 'wx' });
    console.log(`[ota-promote] Captured ${args.branch} baseline: ${args.out}`);
    return;
  }
  const args = parsePromoteArgs(process.argv.slice(2));
  const manifestUrl = process.env.EXPO_UPDATES_URL ?? '';
  const { rolloutPercentage, rolloutReceipt } = args;
  await promoteArchivedOta({
    receiptPath: args.receipt,
    iosExport: args.iosExport,
    androidExport: args.androidExport,
    manifestUrl,
    token: process.env.EOO_TOKEN ?? '',
    branch: args.branch,
    ...(rolloutPercentage === null || rolloutReceipt === null
      ? {}
      : {
          rollout: {
            percentage: rolloutPercentage,
            receiptPath: rolloutReceipt,
            // Only the login comes from the environment. The server is the one
            // EXPO_UPDATES_URL names, exactly as for the publish calls: an admin
            // read against any other host would confirm a rollout on a server
            // the bytes were never sent to.
            connect: (appId: string) =>
              adminClientFromEnvironment({
                appId,
                defaultBaseUrl: manifestUrl,
                environment: {
                  OTA_ADMIN_EMAIL: process.env.OTA_ADMIN_EMAIL,
                  OTA_ADMIN_PASSWORD: process.env.OTA_ADMIN_PASSWORD,
                },
              }),
          },
        }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`[ota-promote] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
