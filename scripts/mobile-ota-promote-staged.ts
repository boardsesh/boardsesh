/// <reference types="node" />

/** Dependency-free preflight and read-only per-platform evidence for an emergency promotion. */
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  captureProductionBaseline,
  parseStageReceipt,
  validateExport,
  verifyServedExport,
} from './mobile-ota-promote.ts';
import type { StageReceipt } from './mobile-ota-promote.ts';
import type { OtaPlatform, ValidatedExport } from './lib/ota-publish-protocol.ts';

export interface StagedPreflight {
  receipt: StageReceipt;
  exports: Record<OtaPlatform, ValidatedExport>;
}

export function preflightStagedPromotion(stage: string, sourceSha: string): StagedPreflight {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('Source SHA must be a full lowercase commit SHA.');
  const receipt = parseStageReceipt(JSON.parse(readFileSync(join(stage, 'receipt.json'), 'utf8')) as unknown);
  if (receipt.commitHash !== sourceSha) throw new Error('Archived receipt does not match the pinned source SHA.');
  const exports = {
    ios: validateExport(join(stage, 'ios'), 'ios', receipt.platforms.ios.bundleSha256),
    android: validateExport(join(stage, 'android'), 'android', receipt.platforms.android.bundleSha256),
  };
  if (exports.ios.appId !== exports.android.appId) throw new Error('Archived platforms must share an app ID.');
  for (const platform of ['ios', 'android'] as const) {
    if (!/^[0-9a-f]{40}$/.test(receipt.platforms[platform].runtimeVersion))
      throw new Error(`${platform} runtime must be a full lowercase fingerprint.`);
    const configRuntime = exports[platform].expoConfig.runtimeVersion;
    const usesFingerprintPolicy =
      typeof configRuntime === 'object' &&
      configRuntime !== null &&
      !Array.isArray(configRuntime) &&
      Object.keys(configRuntime).length === 1 &&
      'policy' in configRuntime &&
      configRuntime.policy === 'fingerprint';
    if (configRuntime !== receipt.platforms[platform].runtimeVersion && !usesFingerprintPolicy)
      throw new Error(`${platform} archived Expo config runtime differs from its receipt.`);
  }
  return { receipt, exports };
}

/** Refuse a stale source before unlock can change production; never replace the saved baselines. */
export async function assertStagedProductionBaselines(
  preflight: StagedPreflight,
  manifestUrl: string,
  capture: typeof captureProductionBaseline = captureProductionBaseline,
): Promise<void> {
  const current = await capture({
    manifestUrl,
    appId: preflight.exports.ios.appId,
    runtimeVersions: {
      ios: preflight.receipt.platforms.ios.runtimeVersion,
      android: preflight.receipt.platforms.android.runtimeVersion,
    },
  });
  for (const platform of ['ios', 'android'] as const) {
    if (current[platform] !== preflight.receipt.baselineProductionUpdateIds[platform])
      throw new Error(`${platform} production baseline changed since staging; refusing unlock and stale promotion.`);
  }
}

export interface PlatformEvidence {
  platform: OtaPlatform;
  verified: boolean;
  updateId?: string;
  error?: string;
}

/** Try both platforms independently: a first-platform error must not hide a completed second platform. */
export async function reportStagedPromotion(
  preflight: StagedPreflight,
  manifestUrl: string,
  verify: typeof verifyServedExport = verifyServedExport,
): Promise<PlatformEvidence[]> {
  const evidence: PlatformEvidence[] = [];
  for (const platform of ['ios', 'android'] as const) {
    try {
      const updateId = await verify(
        manifestUrl,
        preflight.exports[platform],
        preflight.receipt.platforms[platform].runtimeVersion,
        fetch,
        'production',
      );
      evidence.push({ platform, verified: true, updateId });
    } catch (error) {
      evidence.push({ platform, verified: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return evidence;
}

export function formatPromotionReport(evidence: PlatformEvidence[], promotionOutcome: string): string {
  return [
    `Staged production promotion: ${promotionOutcome}.`,
    ...evidence.map((entry) =>
      entry.verified
        ? `${entry.platform}: production serves the archived bundle, assets and Expo config (${entry.updateId}).`
        : `${entry.platform}: archived production bytes were NOT verified (${entry.error}).`,
    ),
    ...(promotionOutcome !== 'success' || evidence.some((entry) => !entry.verified)
      ? ['Stop: inspect both production heads before recovery. Do not blindly rerun or replace the saved baselines.']
      : []),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const [command, ...flags] = process.argv.slice(2);
  if (command !== 'preflight' && command !== 'report') throw new Error('Expected preflight or report.');
  const args = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const argument = flags[index + 1];
    if (!['--stage', '--source-sha'].includes(flag) || !argument || argument.startsWith('--') || args.has(flag))
      throw new Error(`Invalid or duplicate argument: ${flag}.`);
    args.set(flag, argument);
  }
  const stage = args.get('--stage');
  const sourceSha = args.get('--source-sha');
  if (!stage || !sourceSha) throw new Error('--stage and --source-sha are required.');
  const preflight = preflightStagedPromotion(stage, sourceSha);
  if (command === 'preflight') {
    await assertStagedProductionBaselines(
      preflight,
      process.env.EXPO_UPDATES_URL || 'https://updates.boardsesh.com/manifest',
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `ios_runtime=${preflight.receipt.platforms.ios.runtimeVersion}\nandroid_runtime=${preflight.receipt.platforms.android.runtimeVersion}\n` +
          `app_id=${preflight.exports.ios.appId}\nios_baseline=${preflight.receipt.baselineProductionUpdateIds.ios}\nandroid_baseline=${preflight.receipt.baselineProductionUpdateIds.android}\n`,
      );
    console.log(`Validated both archived exports for ${sourceSha}; production baselines remain unchanged.`);
    return;
  }
  const evidence = await reportStagedPromotion(
    preflight,
    process.env.EXPO_UPDATES_URL || 'https://updates.boardsesh.com/manifest',
  );
  const report = formatPromotionReport(evidence, process.env.PROMOTION_OUTCOME ?? 'unknown');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (evidence.some((entry) => !entry.verified)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
