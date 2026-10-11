/// <reference types="node" />
/** Retry a retained OTA export, including map acceptance, without running Metro. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishArchivedOta, validateExport } from './mobile-ota-promote';
import {
  uploadMobileSourceMaps,
  validateSourceMapOutput,
  assertSourceMapExportHashes,
} from './mobile-upload-sourcemaps';
export async function retryArchivedOta(receiptPath: string): Promise<void> {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
  if (receipt.platform !== 'ios' && receipt.platform !== 'android') throw new Error('Invalid receipt platform.');
  for (const field of ['bundleSha256', 'runtimeVersion', 'commitHash', 'branch'])
    if (typeof receipt[field] !== 'string' || !receipt[field]) throw new Error(`Invalid receipt ${field}.`);
  const platform = receipt.platform;
  const exportDir = join(dirname(resolve(receiptPath)), 'export');
  const mobileDir = resolve('packages/mobile');
  const bundleSha256 = receipt.bundleSha256 as string;
  assertSourceMapExportHashes(exportDir, receipt.fileHashes);
  validateExport(exportDir, platform, bundleSha256);
  const artifacts = validateSourceMapOutput(mobileDir, exportDir, platform);
  if (
    !Array.isArray(receipt.debugIds) ||
    JSON.stringify(artifacts.map((artifact) => artifact.debugId)) !== JSON.stringify(receipt.debugIds)
  )
    throw new Error('Retained debug IDs differ from publication receipt.');
  uploadMobileSourceMaps({ platform, mobileDir, outputDir: exportDir });
  await publishArchivedOta({
    exportDir,
    platform,
    bundleSha256,
    runtimeVersion: receipt.runtimeVersion as string,
    branch: receipt.branch as string,
    commitHash: receipt.commitHash as string,
    message: typeof receipt.message === 'string' ? receipt.message : '',
    manifestUrl: process.env.EXPO_UPDATES_URL ?? '',
    token: process.env.EOO_TOKEN ?? '',
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const receipt = process.argv[2];
  if (!receipt) throw new Error('Provide a retained receipt.json path.');
  retryArchivedOta(receipt).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
