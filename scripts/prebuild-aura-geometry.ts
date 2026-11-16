import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { listCatalogueEntries } from '../packages/shared/board-render/src/render-version-projection';
import {
  isAuraGeometryAsset,
  readAuraGeometryManifest,
  type AuraGeometryAsset,
} from '../packages/mobile/src/lib/aura-assets/manifest';
import type { StaticAssetRecord } from '../packages/shared/static-assets/src/types';
import { buildCatalogueGpuConfig } from './gpu-atlas-census';
import {
  publishAuraGeometryManifest,
  requireDeterministicAuraGeometry,
  verifyAuraGeometryPublic,
} from './lib/aura-geometry-publish';
import {
  createRequestStartLimiter,
  putImmutableObjectIfMissing,
  STATIC_ASSET_CACHE_CONTROL,
} from './lib/static-asset-upload';
import { validateRemoteAsset } from './upload-static-assets';

function argument(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const candidate = arguments_[index + 1];
  if (!candidate || candidate.startsWith('--')) throw new Error(`Missing argument: ${name}`);
  return candidate;
}

function requiredEnvironment(name: string): string {
  const configured = process.env[name]?.trim();
  if (!configured) throw new Error(`Missing required environment variable: ${name}`);
  return configured;
}

function invokeGenerator(configPath: string, outputPath: string): Record<string, unknown> {
  const invocation = spawnSync(
    'vp',
    [
      'exec',
      'cargo',
      'run',
      '--quiet',
      '--release',
      '--manifest-path',
      'packages/board-renderer/core/Cargo.toml',
      '--example',
      'prepare_gpu_geometry',
      '--',
      configPath,
      outputPath,
    ],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
  );
  if (invocation.status !== 0) throw new Error(`Aura geometry generation failed: ${invocation.stderr.trim()}`);
  const report: unknown = JSON.parse(invocation.stdout);
  if (report === null || typeof report !== 'object' || Array.isArray(report))
    throw new Error('Invalid Aura generator report');
  return report as Record<string, unknown>;
}

function staticAsset(asset: AuraGeometryAsset): StaticAssetRecord {
  return { ...asset, logicalPath: asset.objectKey, contentType: 'application/octet-stream', nativeBundle: false };
}

/** Generate locally by default. --publish verifies CDN bytes before changing a shipped manifest. */
export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const publish = arguments_.includes('--publish');
  const releasePath = argument(arguments_, '--release-manifest');
  if (releasePath && !publish) throw new Error('--release-manifest requires --publish and successful CDN verification');
  const outputDirectory = resolve(argument(arguments_, '--out') ?? '/tmp/boardsesh-aura-prebuild');
  mkdirSync(outputDirectory, { recursive: true });
  const entries = listCatalogueEntries();
  if (entries.length !== 51) throw new Error(`Expected the complete 51-configuration census; found ${entries.length}`);
  const assets: AuraGeometryAsset[] = [];
  const artifactPaths = new Map<string, string>();
  const reports: Record<string, unknown>[] = [];
  for (const [index, entry] of entries.entries()) {
    const identity = `${entry.boardName}-${entry.layoutId}-${entry.sizeId}`;
    const configPath = resolve(outputDirectory, `${identity}.json`);
    const firstPath = resolve(outputDirectory, `${identity}.aura`);
    const repeatedPath = resolve(outputDirectory, `${identity}.repeat.aura`);
    writeFileSync(configPath, `${JSON.stringify(buildCatalogueGpuConfig(entry))}\n`);
    const report = invokeGenerator(configPath, firstPath);
    invokeGenerator(configPath, repeatedPath);
    const bytes = readFileSync(firstPath);
    const sha256 = requireDeterministicAuraGeometry(bytes, readFileSync(repeatedPath));
    unlinkSync(repeatedPath);
    if (report.sha256 !== sha256 || report.bytes !== bytes.byteLength)
      throw new Error(`Invalid generator checksum: ${identity}`);
    const pulseReach = report.pulseReach;
    if (typeof pulseReach !== 'number' || pulseReach < 1.35 || pulseReach > 1.350001) {
      throw new Error(`Insufficient editor pulse padding: ${identity}`);
    }
    const asset = {
      boardType: entry.boardName,
      layoutId: entry.layoutId,
      sizeId: entry.sizeId,
      geometryId: report.geometryId,
      formatRevision: report.formatRevision,
      atlasFormatRevision: 2,
      outputWidth: report.width,
      outputHeight: report.height,
      sha256,
      bytes: bytes.byteLength,
      maxReach: report.maxReach,
      pulseReach: 1.35,
      objectKey: `static/v1/${sha256}.aura`,
    };
    if (!isAuraGeometryAsset(asset)) throw new Error(`Unsupported generated Aura geometry: ${identity}`);
    const immutablePath = resolve(outputDirectory, `${sha256}.aura`);
    renameSync(firstPath, immutablePath);
    artifactPaths.set(sha256, immutablePath);
    assets.push(asset);
    reports.push({ ...entry, ...report, deterministic: true });
    console.log(`[${index + 1}/${entries.length}] ${identity}: ${bytes.byteLength} bytes, deterministic`);
  }
  const candidate = readAuraGeometryManifest({ version: 1, assets });
  if (!candidate) throw new Error('Generated Aura geometry manifest is invalid');
  writeFileSync(resolve(outputDirectory, 'manifest.candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`);
  writeFileSync(
    resolve(outputDirectory, 'generation-report.json'),
    `${JSON.stringify({ entries: reports.length, reports }, null, 2)}\n`,
  );
  if (!publish) return;

  const bucket = requiredEnvironment('STATIC_ASSETS_S3_BUCKET_NAME');
  if (bucket !== 'boardsesh-static-assets')
    throw new Error('Aura publication requires the existing static-assets bucket');
  const client = new S3Client({
    endpoint: requiredEnvironment('STATIC_ASSETS_AWS_ENDPOINT_URL'),
    region: requiredEnvironment('STATIC_ASSETS_AWS_REGION'),
    credentials: {
      accessKeyId: requiredEnvironment('STATIC_ASSETS_AWS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('STATIC_ASSETS_AWS_SECRET_ACCESS_KEY'),
    },
    maxAttempts: 3,
  });
  const beforeRequest = createRequestStartLimiter(5);
  try {
    await publishAuraGeometryManifest(candidate, {
      async readArtifact(asset) {
        const artifactPath = artifactPaths.get(asset.sha256);
        if (!artifactPath) throw new Error(`Missing Aura artifact: ${asset.sha256}`);
        return readFileSync(artifactPath);
      },
      async putImmutable(asset, bytes) {
        await putImmutableObjectIfMissing(async () => {
          await beforeRequest();
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: asset.objectKey,
              Body: bytes,
              ContentType: 'application/octet-stream',
              CacheControl: STATIC_ASSET_CACHE_CONTROL,
              ContentLength: bytes.byteLength,
              ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
              IfNoneMatch: '*',
            }),
            { abortSignal: AbortSignal.timeout(60_000) },
          );
        });
      },
      verifyStoredObject: (asset) => validateRemoteAsset(client, bucket, staticAsset(asset), beforeRequest),
      verifyPublicObject: (asset) => verifyAuraGeometryPublic(asset, beforeRequest),
      async releaseManifest(manifest) {
        const destination = resolve(releasePath ?? resolve(outputDirectory, 'manifest.verified.json'));
        const partial = `${destination}.part`;
        writeFileSync(partial, `${JSON.stringify(manifest, null, 2)}\n`);
        renameSync(partial, destination);
        console.log(`Verified all ${manifest.assets.length} CDN entries; released ${destination}`);
      },
    });
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error &&
        /^(Missing required|Aura |Invalid |Expected |Unsupported |Insufficient |--release)/.test(error.message)
        ? error.message
        : 'Aura generation or publication failed; the shipped manifest was not changed',
    );
    process.exitCode = 1;
  });
}
