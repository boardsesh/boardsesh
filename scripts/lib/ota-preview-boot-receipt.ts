/// <reference types="node" />

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  object,
  string,
  UPDATE_ID,
  validateExport,
  requestManifest,
  classifyServedManifest,
  type OtaPlatform,
} from './ota-publish-protocol.ts';
import { readServedHead, sha256HexToBase64Url } from './ota-boot-check.ts';

export interface PreviewPlatformReceipt {
  commitHash: string;
  branch: string;
  platform: OtaPlatform;
  runtimeVersion: string;
  bundleSha256: string;
  updateId: string;
}

export function parsePreviewPlatform(input: unknown, platform: OtaPlatform): PreviewPlatformReceipt {
  const receipt = object(input, 'Preview platform receipt');
  if (
    receipt.platform !== platform ||
    typeof receipt.branch !== 'string' ||
    !/^pr-[1-9][0-9]*$/.test(receipt.branch) ||
    typeof receipt.commitHash !== 'string' ||
    !/^[0-9a-f]{40}$/.test(receipt.commitHash) ||
    typeof receipt.runtimeVersion !== 'string' ||
    !/^[0-9a-f]{40}$/.test(receipt.runtimeVersion) ||
    typeof receipt.bundleSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(receipt.bundleSha256) ||
    typeof receipt.updateId !== 'string' ||
    !UPDATE_ID.test(receipt.updateId)
  )
    throw new Error('Invalid preview platform receipt.');
  return receipt as unknown as PreviewPlatformReceipt;
}

export function collectPreviewReceipt(
  iosInput: unknown,
  androidInput: unknown,
  metadata: {
    headSha: string;
    branch: string;
    runId: number;
    deploymentId: number;
  },
) {
  const ios = parsePreviewPlatform(iosInput, 'ios');
  const android = parsePreviewPlatform(androidInput, 'android');
  for (const receipt of [ios, android]) {
    if (receipt.commitHash !== metadata.headSha || receipt.branch !== metadata.branch)
      throw new Error('Preview receipts disagree with the pinned commit/branch.');
  }
  if (![metadata.runId, metadata.deploymentId].every((id) => Number.isSafeInteger(id) && id > 0))
    throw new Error('Invalid preview provenance IDs.');
  const fields = (receipt: PreviewPlatformReceipt) => ({
    runtimeVersion: receipt.runtimeVersion,
    bundleSha256: receipt.bundleSha256,
    updateId: receipt.updateId,
  });
  return {
    version: 1,
    commitHash: metadata.headSha,
    branch: metadata.branch,
    previewRunId: metadata.runId,
    deploymentId: metadata.deploymentId,
    platforms: { ios: fields(ios), android: fields(android) },
  };
}

/** Reads the retained upload's bytes, then requires the public device endpoint to serve those exact bytes. */
export async function recordPreviewPlatformReceipt(
  options: {
    platform: OtaPlatform;
    runtimeVersion: string;
    branch: string;
    commitHash: string;
    exportDir: string;
    manifestUrl: string;
    outPath: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<PreviewPlatformReceipt> {
  const metadata = object(
    JSON.parse(readFileSync(resolve(options.exportDir, 'metadata.json'), 'utf8')) as unknown,
    'Expo metadata',
  );
  const platformMetadata = object(object(metadata.fileMetadata, 'fileMetadata')[options.platform], 'platform metadata');
  const bundlePath = string(platformMetadata.bundle, 'bundle path');
  const segments = bundlePath.split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    bundlePath.includes('\\') ||
    bundlePath.includes('\0') ||
    /^[a-z]:/i.test(bundlePath)
  )
    throw new Error('Unsafe preview bundle path.');
  let absolutePath = resolve(options.exportDir);
  for (const segment of segments) {
    absolutePath = resolve(absolutePath, segment);
    if (lstatSync(absolutePath).isSymbolicLink()) throw new Error('Symbolic preview bundle path.');
  }
  const bundleSha256 = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  const exportFiles = validateExport(options.exportDir, options.platform, bundleSha256);
  const cancellation = new AbortController();
  const deadline = setTimeout(
    () => cancellation.abort(new Error('Preview manifest deadline exceeded (30 seconds).')),
    30_000,
  );
  try {
    const response = await requestManifest({
      ...options,
      appId: exportFiles.appId,
      signal: cancellation.signal,
      fetchImpl,
    });
    if (!response.ok) throw new Error(`Preview manifest returned HTTP ${response.status}.`);
    const served = classifyServedManifest(await response.text());
    if (served.kind !== 'update') throw new Error('Preview did not serve an update.');
    const head = readServedHead(served.manifest);
    if (
      head.branch !== options.branch ||
      head.runtimeVersion !== options.runtimeVersion ||
      head.launchAssetHash !== sha256HexToBase64Url(bundleSha256)
    )
      throw new Error('Preview head moved or differs from the uploaded export.');
    const receipt = parsePreviewPlatform({ ...options, bundleSha256, updateId: head.id }, options.platform);
    const { commitHash, branch, platform, runtimeVersion, updateId } = receipt;
    const saved = { commitHash, branch, platform, runtimeVersion, bundleSha256, updateId };
    writeFileSync(options.outPath, `${JSON.stringify(saved)}\n`, { flag: 'wx' });
    return saved;
  } catch (error) {
    cancellation.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [iosPath, androidPath, headSha, branch, runId, deploymentId, outPath] = process.argv.slice(2);
  if (!iosPath || !androidPath || !outPath)
    throw new Error('Expected ios/android receipts, SHA, branch, run/deployment IDs and output path.');
  writeFileSync(
    outPath,
    `${JSON.stringify(
      collectPreviewReceipt(
        JSON.parse(readFileSync(iosPath, 'utf8')) as unknown,
        JSON.parse(readFileSync(androidPath, 'utf8')) as unknown,
        { headSha, branch, runId: Number(runId), deploymentId: Number(deploymentId) },
      ),
    )}\n`,
    { flag: 'wx' },
  );
}
