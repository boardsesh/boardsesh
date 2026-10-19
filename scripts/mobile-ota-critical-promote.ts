/// <reference types="node" />

/** Publish frozen critical bytes to everyone, superseding only the controller's proven canaries. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { promoteArchivedOta, readProductionManifest } from './mobile-ota-promote.ts';
import type { StageReceipt } from './mobile-ota-promote.ts';
import { preflightStagedPromotion } from './mobile-ota-promote-staged.ts';
import { object, string, UPDATE_ID } from './lib/ota-publish-protocol.ts';
import type { OtaPlatform } from './lib/ota-publish-protocol.ts';
import { listActiveRollouts, revertRollout } from './lib/ota-rollout.ts';
import type { ActiveRollout } from './lib/ota-rollout.ts';
import { initialStableState, parseStableState, PLATFORMS } from './lib/ota-stable.ts';
import type { StableRelease } from './lib/ota-stable.ts';
import { adminClientFromEnvironment, sameId } from './lib/xprem-admin.mts';
import type { XpremAdminClient } from './lib/xprem-admin.mts';

interface ControlContent {
  runtimeVersion: string;
  launchHash: string;
  assetHashes: string[];
  expoClient: Record<string, unknown>;
}
interface SupersessionPlan {
  rollout: ActiveRollout;
  platform: OtaPlatform;
  controlUpdateUUID: string;
  content: ControlContent;
}
interface RevertEvidence {
  requested: boolean;
  reverted?: boolean;
  observedUpdateId?: string;
  attestedUpdateId?: string;
}
interface CriticalEvidence {
  version: 1;
  sourceSha: string;
  checkpointRunId: string;
  originalReceipt: StageReceipt;
  planned: SupersessionPlan[];
  platforms: Partial<Record<OtaPlatform, RevertEvidence>>;
  status: 'validated' | 'reverting' | 'promoting' | 'complete' | 'failed';
  error?: string;
}

function manifestId(manifest: Record<string, unknown> | null, platform: OtaPlatform): string | null {
  if (manifest === null) return null;
  const updateId = string(manifest.id, `${platform} production update ID`);
  if (!UPDATE_ID.test(updateId)) throw new Error(`${platform} production update ID must be a UUID.`);
  return updateId;
}

/** Compare content identity, allowing only the new UUID, timestamp and asset URLs to differ. */
function controlContent(manifest: Record<string, unknown>, platform: OtaPlatform, appId: string): ControlContent {
  const runtimeVersion = string(manifest.runtimeVersion, `${platform} control runtime`);
  if (!/^[a-f0-9]{40}$/.test(runtimeVersion)) throw new Error(`${platform} control runtime is invalid.`);
  const contentHash = (input: unknown): string => {
    const hash = string(input, `${platform} control content hash`);
    if (!/^[A-Za-z0-9_-]{43}$/.test(hash)) throw new Error(`${platform} control content hash is invalid.`);
    return hash;
  };
  const launchAsset = object(manifest.launchAsset, `${platform} control launch asset`);
  if (!Array.isArray(manifest.assets)) throw new Error(`${platform} control assets must be an array.`);
  const assetHashes = manifest.assets.map((asset: unknown) =>
    contentHash(object(asset, `${platform} control asset`).hash),
  );
  const extra = object(manifest.extra, `${platform} control extra`);
  if (extra.branch !== 'production') throw new Error(`${platform} control must be on production.`);
  const expoClient = object(extra.expoClient, `${platform} control Expo config`);
  const updates = object(expoClient.updates, `${platform} control updates config`);
  const headers = object(updates.requestHeaders, `${platform} control request headers`);
  if (headers['expo-app-id'] !== appId || headers['expo-channel-name'] !== 'production')
    throw new Error(`${platform} control Expo config has a different app or channel.`);
  return { runtimeVersion, launchHash: contentHash(launchAsset.hash), assetHashes: assetHashes.sort(), expoClient };
}

async function ownedPlan(
  client: XpremAdminClient,
  rollout: ActiveRollout,
  active: StableRelease | null,
  receipt: StageReceipt,
  manifests: Record<OtaPlatform, Record<string, unknown> | null>,
  appId: string,
): Promise<SupersessionPlan> {
  const platform = rollout.platform;
  if (
    (platform !== 'ios' && platform !== 'android') ||
    rollout.branch !== 'production' ||
    !active ||
    !/^\d+$/.test(String(rollout.updateId)) ||
    !sameId(rollout.updateId, active.updateIds[platform] ?? '') ||
    rollout.runtimeVersion !== active.candidate.receipt.platforms[platform].runtimeVersion ||
    rollout.runtimeVersion !== receipt.platforms[platform].runtimeVersion
  )
    throw new Error(`Unowned rollout ${rollout.updateId}; refusing all critical production writes.`);
  const canary = await client.getUpdateDetails('production', rollout.runtimeVersion, rollout.updateId);
  if (
    !sameId(canary.updateId, rollout.updateId) ||
    canary.platform !== platform ||
    canary.commitHash !== active.candidate.receipt.commitHash ||
    typeof canary.updateUUID !== 'string' ||
    !UPDATE_ID.test(canary.updateUUID)
  )
    throw new Error(`${platform} canary identity differs from controller ownership.`);
  if (rollout.controlUpdateId === null || !/^\d+$/.test(String(rollout.controlUpdateId)))
    throw new Error(`${platform} canary has no identifiable control.`);
  const control = await client.getUpdateDetails('production', rollout.runtimeVersion, rollout.controlUpdateId);
  const controlUpdateUUID = active.candidate.receipt.baselineProductionUpdateIds[platform];
  if (
    !sameId(control.updateId, rollout.controlUpdateId) ||
    control.platform !== platform ||
    controlUpdateUUID === null ||
    control.updateUUID !== controlUpdateUUID ||
    receipt.baselineProductionUpdateIds[platform] !== controlUpdateUUID
  )
    throw new Error(`${platform} canary control differs from its captured and staged baselines.`);
  const manifest = manifests[platform];
  if (manifest === null || manifestId(manifest, platform) !== controlUpdateUUID)
    throw new Error(`${platform} production does not serve the captured control.`);
  return { rollout, platform, controlUpdateUUID, content: controlContent(manifest, platform, appId) };
}

export interface CriticalPromotionOptions {
  stage: string;
  sourceSha: string;
  /** Restored by the trusted artifact reader while holding the production concurrency lock. */
  state: unknown;
  /** Producer run selected by that reader, or 0 only when no checkpoint exists. */
  loadedStateRunId: string;
  manifestUrl: string;
  token: string;
  client: XpremAdminClient;
  fetchImpl?: typeof fetch;
  promote?: typeof promoteArchivedOta;
  preflight?: typeof preflightStagedPromotion;
}

export async function promoteCriticalStagedOta(options: CriticalPromotionOptions): Promise<void> {
  if (!options.token) throw new Error('EOO_TOKEN is required.');
  const evidencePath = join(options.stage, 'critical-supersession.json');
  const derivedReceiptPath = join(options.stage, 'critical-receipt.json');
  if (existsSync(evidencePath) || existsSync(derivedReceiptPath))
    throw new Error('Critical publication evidence already exists. Inspect both heads before operator recovery.');
  const preflight = (options.preflight ?? preflightStagedPromotion)(options.stage, options.sourceSha);
  const state = parseStableState(options.state);
  if (!/^\d+$/.test(options.loadedStateRunId) || state.checkpointRunId !== options.loadedStateRunId)
    throw new Error('Controller checkpoint does not match the trusted artifact producer run.');
  if (state.active?.phase === 'reverting')
    throw new Error('Controller is reverting; critical supersession was refused.');
  const receipt = preflight.receipt;
  const appId = preflight.exports.ios.appId;
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifests = {} as Record<OtaPlatform, Record<string, unknown> | null>;
  const baselineIds = { ...receipt.baselineProductionUpdateIds };
  const readManifest = (platform: OtaPlatform) =>
    readProductionManifest(
      options.manifestUrl,
      platform,
      receipt.platforms[platform].runtimeVersion,
      appId,
      fetchImpl,
      'production',
    );
  const assertBaselines = async (): Promise<void> => {
    for (const platform of PLATFORMS) {
      manifests[platform] = await readManifest(platform);
      if (manifestId(manifests[platform], platform) !== baselineIds[platform])
        throw new Error(`${platform} production baseline changed since staging; refusing critical production writes.`);
    }
  };
  // Every archived byte and both saved production heads are checked before any revert.
  await assertBaselines();
  const live = await listActiveRollouts(options.client, 'production');
  const planned: SupersessionPlan[] = [];
  for (const rollout of live) {
    const plan = await ownedPlan(options.client, rollout, state.active, receipt, manifests, appId);
    if (planned.some((previous) => previous.platform === plan.platform))
      throw new Error(`Multiple ${plan.platform} rollouts; refusing critical supersession.`);
    planned.push(plan);
  }
  const evidence: CriticalEvidence = {
    version: 1,
    sourceSha: options.sourceSha,
    checkpointRunId: state.checkpointRunId,
    originalReceipt: receipt,
    planned,
    platforms: {},
    status: 'validated',
  };
  const saveEvidence = (): void => {
    // Keep the last complete intent if cancellation interrupts the next recovery record.
    const pendingPath = `${evidencePath}.tmp`;
    writeFileSync(pendingPath, `${JSON.stringify(evidence, null, 2)}\n`);
    renameSync(pendingPath, evidencePath);
  };
  try {
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    // The early existence check is advisory; exclusive creation owns this run.
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error('Critical publication evidence already exists. Inspect both heads before operator recovery.');
    throw error;
  }
  try {
    for (const plan of planned) {
      await assertBaselines();
      const outstanding = await listActiveRollouts(options.client, 'production');
      for (const rollout of outstanding) {
        const remaining = planned.find(
          (candidate) => candidate.platform === rollout.platform && !evidence.platforms[candidate.platform]?.reverted,
        );
        if (!remaining || !isDeepStrictEqual(remaining.rollout, rollout))
          throw new Error('Production rollout changed after critical preflight; refusing further writes.');
      }
      // Re-read identities as well as both heads immediately before the exact-ID revert.
      const current = outstanding.find((rollout) => rollout.platform === plan.platform);
      if (!current) throw new Error(`${plan.platform} canary stopped rolling out before critical supersession.`);
      const checked = await ownedPlan(options.client, current, state.active, receipt, manifests, appId);
      if (!isDeepStrictEqual(checked, plan)) throw new Error(`${plan.platform} control content changed before revert.`);
      evidence.status = 'reverting';
      const result: RevertEvidence = { requested: true };
      evidence.platforms[plan.platform] = result;
      saveEvidence();
      await revertRollout(options.client, {
        branch: 'production',
        runtimeVersion: plan.rollout.runtimeVersion,
        platform: plan.platform,
        expectedUpdateId: String(plan.rollout.updateId),
      });
      result.reverted = true;
      saveEvidence();
      const revertedManifest = await readManifest(plan.platform);
      const updateId = manifestId(revertedManifest, plan.platform);
      if (updateId !== null) result.observedUpdateId = updateId;
      saveEvidence();
      if (
        revertedManifest === null ||
        updateId === null ||
        !isDeepStrictEqual(controlContent(revertedManifest, plan.platform, appId), plan.content)
      )
        throw new Error(`${plan.platform} reverted content differs from the saved control; refusing critical publish.`);
      result.attestedUpdateId = updateId;
      baselineIds[plan.platform] = updateId;
      saveEvidence();
    }
    await assertBaselines();
    if ((await listActiveRollouts(options.client, 'production')).length > 0)
      throw new Error('Production still has a rollout; refusing critical publish.');
    let receiptPath = join(options.stage, 'receipt.json');
    if (planned.length > 0) {
      // Only identities attested after this run's exact owned reverts may replace saved baselines.
      writeFileSync(
        derivedReceiptPath,
        `${JSON.stringify({ ...receipt, baselineProductionUpdateIds: baselineIds }, null, 2)}\n`,
        { flag: 'wx' },
      );
      receiptPath = derivedReceiptPath;
    }
    evidence.status = 'promoting';
    saveEvidence();
    await (options.promote ?? promoteArchivedOta)({
      receiptPath,
      iosExport: join(options.stage, 'ios'),
      androidExport: join(options.stage, 'android'),
      manifestUrl: options.manifestUrl,
      token: options.token,
      branch: 'production',
      fetchImpl,
    });
    evidence.status = 'complete';
    saveEvidence();
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? error.message : String(error);
    saveEvidence();
    throw error;
  }
}

export function parseCriticalArgs(argv: string[]): {
  stage: string;
  sourceSha: string;
  statePath: string;
  loadedStateRunId: string;
} {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const argument = argv[index + 1];
    if (
      !['--stage', '--source-sha', '--state', '--loaded-state-run-id'].includes(flag) ||
      !argument ||
      argument.startsWith('--') ||
      args.has(flag)
    )
      throw new Error(`Invalid or duplicate argument: ${flag}.`);
    args.set(flag, argument);
  }
  const stage = args.get('--stage');
  const sourceSha = args.get('--source-sha');
  const statePath = args.get('--state');
  const loadedStateRunId = args.get('--loaded-state-run-id');
  if (!stage || !sourceSha || !statePath || !loadedStateRunId)
    throw new Error('--stage, --source-sha, --state and --loaded-state-run-id are required.');
  return { stage, sourceSha, statePath, loadedStateRunId };
}

async function main(): Promise<void> {
  const args = parseCriticalArgs(process.argv.slice(2));
  const preflight = preflightStagedPromotion(args.stage, args.sourceSha);
  const manifestUrl = process.env.EXPO_UPDATES_URL ?? 'https://updates.boardsesh.com/manifest';
  const client = await adminClientFromEnvironment({
    appId: preflight.exports.ios.appId,
    defaultBaseUrl: manifestUrl,
    environment: { OTA_ADMIN_EMAIL: process.env.OTA_ADMIN_EMAIL, OTA_ADMIN_PASSWORD: process.env.OTA_ADMIN_PASSWORD },
  });
  await promoteCriticalStagedOta({
    ...args,
    state: existsSync(args.statePath)
      ? (JSON.parse(readFileSync(args.statePath, 'utf8')) as unknown)
      : initialStableState(),
    manifestUrl,
    token: process.env.EOO_TOKEN ?? '',
    client,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`[ota-critical] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
