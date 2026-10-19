/// <reference types="node" />

/** Restore only the staged controls; no receipt escapes a failed/partial unlock. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adminClientFromEnvironment, sameId } from './lib/xprem-admin.mts';
import type { XpremAdminClient, XpremRolloutUpdate } from './lib/xprem-admin.mts';
import { sleep } from './lib/ota-publish-protocol.ts';
import type { OtaPlatform } from './lib/ota-publish-protocol.ts';
import {
  readControlHead,
  validateUnlockExpectations,
  validateUnlockProof,
  validateUnlockReceipt,
} from './lib/ota-unlock-receipt.ts';
import type { ControlHead, UnlockExpectations, UnlockProof, UnlockReceipt } from './lib/ota-unlock-receipt.ts';
import { createUnlockLeaseGuard, protectUnlockWrites } from './lib/ota-unlock-lease.mjs';

export async function unlockStagedControls(
  options: UnlockExpectations & {
    proof: UnlockProof;
    client: Pick<XpremAdminClient, 'getUpdateRollout' | 'getUpdateDetails' | 'revertUpdateRollout'>;
    readHead: (platform: OtaPlatform) => Promise<ControlHead>;
    verificationDelaysMs?: readonly number[];
  },
): Promise<UnlockReceipt> {
  validateUnlockExpectations(options);
  validateUnlockProof(options.proof);
  const planned = {} as Record<OtaPlatform, { rollout: XpremRolloutUpdate | null; head: ControlHead }>;
  const inspect = async (platform: OtaPlatform) => {
    const status = await options.client.getUpdateRollout('production', options.runtimes[platform]);
    const matches = status.active ? status.updates.filter((entry) => entry.platform === platform) : [];
    if (matches.length > 1) throw new Error(`${platform} has ambiguous active rollouts.`);
    return matches[0] ?? null;
  };
  const validateControl = async (platform: OtaPlatform, rollout: XpremRolloutUpdate) => {
    if (options.baselines[platform] === null || rollout.controlUpdateId === null)
      throw new Error(`${platform} rollout has no control update.`);
    const control = await options.client.getUpdateDetails(
      'production',
      options.runtimes[platform],
      rollout.controlUpdateId,
    );
    if (
      !sameId(control.updateId, rollout.controlUpdateId) ||
      control.platform !== platform ||
      control.updateUUID !== options.baselines[platform]
    )
      throw new Error(`${platform} live rollout does not replace the staged baseline.`);
  };
  // Both controls must be current before the first platform can be reverted.
  for (const platform of ['ios', 'android'] as const) {
    const rollout = await inspect(platform);
    const head = await options.readHead(platform);
    if (head.updateId !== options.baselines[platform])
      throw new Error(`${platform} production baseline changed before unlock.`);
    if (rollout) await validateControl(platform, rollout);
    planned[platform] = { rollout, head };
  }
  const writtenRuntimes = new Set<string>();
  for (const platform of ['ios', 'android'] as const) {
    const plan = planned[platform];
    const current = await inspect(platform);
    if (plan.rollout === null) {
      if (current !== null) throw new Error(`${platform} rollout appeared during unlock.`);
      continue;
    }
    if (current === null && writtenRuntimes.has(options.runtimes[platform])) continue;
    if (
      current === null ||
      !sameId(current.updateId, plan.rollout.updateId) ||
      !sameId(current.controlUpdateId ?? '', plan.rollout.controlUpdateId ?? '')
    )
      throw new Error(`${platform} rollout changed during unlock.`);
    await validateControl(platform, current);
    const head = await options.readHead(platform);
    if (head.updateId !== plan.head.updateId || head.contentSha256 !== plan.head.contentSha256)
      throw new Error(`${platform} control changed during unlock.`);
    await options.client.revertUpdateRollout('production', options.runtimes[platform], current.updateId);
    writtenRuntimes.add(options.runtimes[platform]);
  }
  const platforms = {} as UnlockReceipt['platforms'];
  // Share the bounded propagation wait across both platform attestations.
  const verificationDelaysMs = options.verificationDelaysMs ?? [1_000, 2_000, 4_000, 8_000];
  let propagationAttempt = 0;
  for (const platform of ['ios', 'android'] as const) {
    const plan = planned[platform];
    let head: ControlHead;
    for (;;) {
      if (await inspect(platform)) throw new Error(`${platform} rollout remains active after unlock.`);
      head = await options.readHead(platform);
      if (
        head.contentSha256 !== plan.head.contentSha256 ||
        (plan.rollout === null && head.updateId !== plan.head.updateId) ||
        (plan.rollout !== null && head.updateId === null)
      )
        throw new Error(`${platform} unlock did not preserve the staged control.`);
      if (plan.rollout === null || head.updateId !== plan.head.updateId) break;
      if (propagationAttempt === verificationDelaysMs.length)
        throw new Error(`${platform} restored control UUID did not become visible after unlock.`);
      await sleep(verificationDelaysMs[propagationAttempt++]);
    }
    platforms[platform] = {
      runtimeVersion: options.runtimes[platform],
      originalUpdateId: options.baselines[platform],
      restoredUpdateId: head.updateId,
      contentSha256: head.contentSha256,
      mode: plan.rollout === null ? 'unchanged' : 'reverted',
    };
  }
  return validateUnlockReceipt(
    { ...options.proof, version: 1, runAttempt: 1, branch: 'production', appId: options.appId, platforms },
    options.proof,
    options,
  );
}

async function main(): Promise<void> {
  if (
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_RUN_ATTEMPT !== '1' ||
    process.env.OTA_BRANCH !== 'production'
  )
    throw new Error('Staged unlock receipts require the first trusted main production attempt.');
  const output = process.argv[2];
  if (!output || process.argv.length !== 3) throw new Error('Provide one unlock receipt output path.');
  const expected: UnlockExpectations = {
    appId: process.env.STAGED_APP_ID ?? '',
    runtimes: { ios: process.env.IOS_RUNTIME_VERSION ?? '', android: process.env.ANDROID_RUNTIME_VERSION ?? '' },
    baselines: {
      ios: process.env.EXPECTED_IOS_UPDATE_ID === 'null' ? null : (process.env.EXPECTED_IOS_UPDATE_ID ?? ''),
      android:
        process.env.EXPECTED_ANDROID_UPDATE_ID === 'null' ? null : (process.env.EXPECTED_ANDROID_UPDATE_ID ?? ''),
    },
  };
  validateUnlockExpectations(expected);
  const assertCallerActive = createUnlockLeaseGuard({
    requestId: process.env.REQUEST_ID,
    serializedLease: process.env.OTA_UNLOCK_CALLER_LEASE,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    branch: process.env.OTA_BRANCH,
    iosRuntime: process.env.IOS_RUNTIME_VERSION ?? '',
    androidRuntime: process.env.ANDROID_RUNTIME_VERSION ?? '',
  });
  await assertCallerActive();
  const manifestUrl = process.env.EXPO_UPDATES_URL || 'https://updates.boardsesh.com/manifest';
  const client = await adminClientFromEnvironment({
    appId: expected.appId,
    defaultBaseUrl: manifestUrl,
    environment: process.env,
  });
  const receipt = await unlockStagedControls({
    ...expected,
    client: protectUnlockWrites(client, assertCallerActive),
    proof: {
      repository: process.env.GITHUB_REPOSITORY ?? '',
      requestId: process.env.REQUEST_ID ?? '',
      runId: Number(process.env.GITHUB_RUN_ID),
      headSha: process.env.GITHUB_SHA ?? '',
    },
    readHead: (platform) =>
      readControlHead({ manifestUrl, appId: expected.appId, platform, runtimeVersion: expected.runtimes[platform] }),
  });
  await assertCallerActive();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
  console.log('Both staged controls restored and attested; no source receipt was changed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
