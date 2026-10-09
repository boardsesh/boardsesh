/// <reference types="node" />
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EARLY_UPDATES_BRANCH } from '../infra/ota/config.ts';
import {
  connectEmptyBranchReader,
  parseStageReceipt,
  promoteArchivedOta,
  validateExport,
} from './mobile-ota-promote.ts';
import type { EmptyBranchReader } from './mobile-ota-promote.ts';
import { object } from './lib/ota-publish-protocol.ts';

/** Copy archived staging bytes to early updates without weakening production's saved baseline guard. */
export async function promoteEarlyTrack(
  stagePath: string,
  manifestUrl: string,
  token: string,
  emptyBranchReader?: EmptyBranchReader,
): Promise<void> {
  const raw = object(JSON.parse(readFileSync(join(stagePath, 'receipt.json'), 'utf8')) as unknown, 'Stage receipt');
  const receipt = parseStageReceipt(raw);
  const baselineProductionUpdateIds = parseStageReceipt({
    ...receipt,
    baselineProductionUpdateIds: raw.baselineEarlyUpdateIds,
  }).baselineProductionUpdateIds;
  const receiptPath = join(stagePath, 'early-receipt.json');
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, baselineProductionUpdateIds }));
  await promoteArchivedOta({
    receiptPath,
    iosExport: join(stagePath, 'ios'),
    androidExport: join(stagePath, 'android'),
    manifestUrl,
    token,
    branch: EARLY_UPDATES_BRANCH,
    ...(emptyBranchReader ? { emptyBranchReader } : {}),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [stagePath, option] = process.argv.slice(2);
  if (!stagePath || process.argv.length > 4 || (option !== undefined && option !== '--verify-empty-target')) {
    throw new Error('Provide the stage archive directory and optional --verify-empty-target.');
  }
  const run = async (): Promise<void> => {
    const manifestUrl = process.env.EXPO_UPDATES_URL ?? '';
    const receipt =
      option === '--verify-empty-target'
        ? parseStageReceipt(JSON.parse(readFileSync(join(stagePath, 'receipt.json'), 'utf8')) as unknown)
        : null;
    const reader = receipt
      ? await connectEmptyBranchReader(
          manifestUrl,
          validateExport(join(stagePath, 'ios'), 'ios', receipt.platforms.ios.bundleSha256).appId,
        )
      : undefined;
    await promoteEarlyTrack(stagePath, manifestUrl, process.env.EOO_TOKEN ?? '', reader);
  };
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
