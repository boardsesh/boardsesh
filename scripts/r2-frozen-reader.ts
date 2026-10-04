/// <reference types="node" />
import { createHash, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSourceMapOutput } from './mobile-upload-sourcemaps';

export const FROZEN_SOURCE = '6986ca9100c0492586f42f1a88ce3d49b4986f07';
export const SNAPSHOT_BASE = 'https://snapshots.boardsesh.com/board-snapshots/v1-gzip';
export const CERT_SHA = 'f5f367cf1451a428f2a4a68f1beccca2dd42275d0df8e3a56a32f0087407f7d5';
export const RUNTIMES = {
  ios: 'c2643067d9b4f56009900f1954305ca73ea799d1',
  android: '04b545294d879a2a9d1fb2ac46a807d3175b39d6',
} as const;
type Platform = keyof typeof RUNTIMES;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected object');
  return input as Record<string, unknown>;
}
export function assertPlatform(input: string): Platform {
  if (input !== 'ios' && input !== 'android') throw new Error('Select one platform');
  return input;
}
export function assertRuntime(platform: Platform, runtime: string): void {
  if (runtime !== RUNTIMES[platform]) throw new Error('Resolved fingerprint differs from shipped cohort');
}
export function assertEnvironment(environment: NodeJS.ProcessEnv, platform: Platform): void {
  for (const key of [
    'EXPO_UPDATES_FINGERPRINT_OVERRIDE',
    'EAS_BUILD',
    'EAS_BUILD_PROFILE',
    'BOARDSESH_WEB',
    'EOO_TOKEN',
    'SENTRY_AUTH_TOKEN',
  ]) {
    if (environment[key]) throw new Error('Unexpected native configuration override');
  }
  if (
    environment.EXPO_PUBLIC_SNAPSHOT_BASE_URL !== SNAPSHOT_BASE ||
    environment.EXPO_UPDATES_URL !== 'https://updates.boardsesh.com/manifest'
  )
    throw new Error('Unexpected public reader configuration');
  if (platform === 'ios' && environment.GOOGLE_MAPS_API_KEY) throw new Error('iOS must not include Android maps input');
  if (platform === 'android' && !environment.GOOGLE_MAPS_API_KEY) throw new Error('Android maps input missing');
}
export function assertR2Bundle(bundle: Buffer): void {
  if (
    bundle.length < 8 ||
    bundle.length > 64 * 1024 * 1024 ||
    bundle.subarray(0, 8).toString('hex') !== 'c61fbc03c103191f'
  )
    throw new Error('Expected bounded Hermes bundle');
  if (!bundle.includes(Buffer.from(SNAPSHOT_BASE))) throw new Error('Compiled bundle lacks R2 snapshot base');
  if (
    ['storage.dev/board-snapshots/', 'boardsesh-board-snapshots.t3.tigrisfiles.io', 't3.tigrisbucket.io'].some((host) =>
      bundle.includes(Buffer.from(host)),
    )
  )
    throw new Error('Compiled bundle retains legacy snapshot base');
}
export function assertFrozenSource(sourceRoot: string): Buffer {
  const git = (args: string[]) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== FROZEN_SOURCE || git(['status', '--porcelain']))
    throw new Error('Frozen source changed');
  const certificate = readFileSync(resolve(sourceRoot, 'packages/mobile/certs/certificate.pem'));
  if (sha256(certificate) !== CERT_SHA) throw new Error('Code signing certificate changed');
  return certificate;
}
export function checkExport(exportRoot: string, platform: Platform): { bundleSha256: string; assetHashes: string[] } {
  const artifacts = validateSourceMapOutput(dirname(resolve(exportRoot)), exportRoot, platform);
  if (artifacts.length !== 1) throw new Error('Expected one Hermes entry bundle');
  const artifact = artifacts[0];
  const bundle = readFileSync(artifact.bundlePath);
  assertR2Bundle(bundle);
  const metadata = object(JSON.parse(readFileSync(resolve(exportRoot, 'metadata.json'), 'utf8')) as unknown);
  const assets = object(object(metadata.fileMetadata)[platform]).assets;
  if (!Array.isArray(assets)) throw new Error('Missing exported asset list');
  const assetHashes = assets
    .map((entry: unknown) => {
      const assetPath = object(entry).path;
      if (
        typeof assetPath !== 'string' ||
        assetPath.startsWith('/') ||
        assetPath.includes('\\') ||
        assetPath.split('/').some((part) => !part || part === '..' || part === '.')
      )
        throw new Error('Unsafe exported asset path');
      return createHash('sha256')
        .update(readFileSync(resolve(exportRoot, assetPath)))
        .digest('base64url');
    })
    .sort();
  return { bundleSha256: sha256(bundle), assetHashes };
}
export function parseSignedManifest(contentType: string, body: string, certificate: Buffer): Record<string, unknown> {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const separator = boundary?.[1] ?? boundary?.[2];
  if (!contentType.startsWith('multipart/mixed') || !separator || separator.length > 200)
    throw new Error('Expected signed multipart manifest');
  const manifests: Record<string, unknown>[] = [];
  for (const part of body.split(`--${separator}`)) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const headers = part.slice(0, split);
    if (!/name="manifest"/i.test(headers)) continue;
    const payload = part.slice(split + 4).replace(/\r\n$/, '');
    const signatureHeader = /^expo-signature:\s*(.+)$/im.exec(headers)?.[1];
    const signature = signatureHeader && /(?:^|[,;]\s*)sig="([A-Za-z0-9+/=]+)"/.exec(signatureHeader)?.[1];
    if (
      !signature ||
      !/keyid="main"/.test(signatureHeader ?? '') ||
      !verify('RSA-SHA256', Buffer.from(payload), certificate, Buffer.from(signature, 'base64'))
    )
      throw new Error('Manifest signature invalid');
    manifests.push(object(JSON.parse(payload) as unknown));
  }
  if (manifests.length !== 1) throw new Error('Expected exactly one signed update');
  return manifests[0];
}
export function validateManifest(manifest: Record<string, unknown>, platform: Platform, startedAt: string): void {
  assertRuntime(platform, String(manifest.runtimeVersion));
  if (object(manifest.extra).branch !== 'production') throw new Error('Wrong production branch');
  if (typeof manifest.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(manifest.id)) throw new Error('Invalid update ID');
  const createdAt = Date.parse(String(manifest.createdAt));
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(createdAt) || createdAt <= start || createdAt > Date.now() + 60000)
    throw new Error('Update is not newly published');
  if (!Array.isArray(manifest.assets) || manifest.assets.length > 2000) throw new Error('Invalid asset list');
}
async function boundedBody(response: Response, cap: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error('Public delivery failed');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > cap) {
      await response.body.cancel().catch(() => undefined);
      throw new Error('Public response exceeded bound');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function isPrivateR2Url(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    (url.hostname === 'boardsesh-ota-v3.7e9cab940b939f124941596d68fe0199.r2.cloudflarestorage.com' ||
      (url.hostname === '7e9cab940b939f124941596d68fe0199.r2.cloudflarestorage.com' &&
        url.pathname.startsWith('/boardsesh-ota-v3/')))
  );
}
async function readPrivateR2Asset(url: URL): Promise<Buffer> {
  if (isPrivateR2Url(url))
    return boundedBody(await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) }), 64 * 1024 * 1024);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'updates.boardsesh.com' ||
    !url.pathname.startsWith('/assets/') ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Asset is not delivered from the private R2 bucket');
  const redirect = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
  if (![301, 302, 303, 307, 308].includes(redirect.status)) throw new Error('Expected private R2 asset redirect');
  const location = redirect.headers.get('location');
  await redirect.body?.cancel();
  if (!location) throw new Error('Missing private R2 redirect target');
  const target = new URL(location, url);
  if (!isPrivateR2Url(target)) throw new Error('Unexpected private R2 redirect target');
  // A single explicit hop; no request headers or authentication forwarded.
  return boundedBody(await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(120000) }), 64 * 1024 * 1024);
}
export async function verifyDelivery(
  platform: Platform,
  startedAt: string,
  certificate: Buffer,
  expectedBundleSha: string,
  expectedAssetHashes: string[],
): Promise<Record<string, unknown>> {
  const response = await fetch('https://updates.boardsesh.com/manifest', {
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
    headers: {
      'expo-platform': platform,
      'expo-runtime-version': RUNTIMES[platform],
      'expo-channel-name': 'production',
      'expo-app-id': '007e6fd7-f200-448c-9449-8d48ba5d51fc',
      'xprem-branch': '',
      'expo-protocol-version': '1',
      'expo-expect-signature': 'keyid="main", alg="rsa-v1_5-sha256"',
      accept: 'multipart/mixed',
    },
  });
  const manifest = parseSignedManifest(
    response.headers.get('content-type') ?? '',
    (await boundedBody(response, 4 * 1024 * 1024)).toString('utf8'),
    certificate,
  );
  validateManifest(manifest, platform, startedAt);
  const deliveredHashes = (manifest.assets as unknown[]).map((entry) => String(object(entry).hash)).sort();
  if (JSON.stringify(deliveredHashes) !== JSON.stringify(expectedAssetHashes))
    throw new Error('Served asset list differs from exported asset list');
  const assets = [object(manifest.launchAsset), ...(manifest.assets as unknown[]).map(object)];
  let totalBytes = 0;
  for (const [index, asset] of assets.entries()) {
    const url = new URL(String(asset.url));
    const bytes = await readPrivateR2Asset(url);
    totalBytes += bytes.length;
    if (totalBytes > 256 * 1024 * 1024 || createHash('sha256').update(bytes).digest('base64url') !== asset.hash)
      throw new Error('Delivered asset hash mismatch');
    if (index === 0) {
      assertR2Bundle(bytes);
      if (sha256(bytes) !== expectedBundleSha) throw new Error('Served launch bundle differs from exported bundle');
    }
  }
  return {
    platform,
    runtimeVersion: RUNTIMES[platform],
    updateId: manifest.id,
    createdAt: manifest.createdAt,
    assets: assets.length,
    totalBytes,
    bundleSha256: expectedBundleSha,
  };
}
async function main(): Promise<void> {
  const [mode, sourceRoot, platformInput, exportRoot, receiptPath, startedAt] = process.argv.slice(2);
  const platform = assertPlatform(platformInput ?? '');
  if (!sourceRoot || !exportRoot || !receiptPath || (mode !== 'export' && mode !== 'delivery'))
    throw new Error('Invalid reader proof invocation');
  assertEnvironment(process.env, platform);
  const certificate = assertFrozenSource(sourceRoot);
  const exported = checkExport(exportRoot, platform);
  const proof =
    mode === 'delivery'
      ? await verifyDelivery(platform, startedAt ?? '', certificate, exported.bundleSha256, exported.assetHashes)
      : { platform, sourceCommit: FROZEN_SOURCE, ...exported };
  writeFileSync(receiptPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`${platform} R2 ${mode} proof passed`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch(() => {
    console.error('::error::R2 reader proof failed');
    process.exitCode = 1;
  });
