/// <reference types="node" />
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EARLY_UPDATES_BRANCH } from '../infra/ota/config.ts';
import { parseStageReceipt, promoteArchivedOta } from './mobile-ota-promote.ts';
import { object } from './lib/ota-publish-protocol.ts';

/** Copy archived staging bytes to early updates without weakening production's saved baseline guard. */
export async function promoteEarlyTrack(stagePath: string, manifestUrl: string, token: string): Promise<void> {
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
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [stagePath] = process.argv.slice(2);
  if (!stagePath || process.argv.length !== 3) throw new Error('Provide the stage archive directory.');
  promoteEarlyTrack(stagePath, process.env.EXPO_UPDATES_URL ?? '', process.env.EOO_TOKEN ?? '').catch(
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
