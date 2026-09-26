/// <reference types="node" />

/**
 * Promote the archived, already-exported main OTA to the existing production branch.
 * xprem 3.1.2 cannot republish across branches. This uses the same upload/finalize
 * protocol as eoas@3.1.2, but never runs Expo export again. The pipeline must first
 * verify that the staged commit's GraphQL schema is live.
 *
 * vp exec tsx scripts/mobile-ota-promote.ts --receipt ota-stage/receipt.json \
 *   --ios-export ota-stage/ios --android-export ota-stage/android
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export type OtaPlatform = 'ios' | 'android';

export interface StageReceipt {
  commitHash: string;
  message: string;
  platforms: Record<OtaPlatform, { runtimeVersion: string; bundleSha256: string }>;
  baselineProductionUpdateIds: Record<OtaPlatform, string | null>;
}

interface ExportFile {
  relativePath: string;
  absolutePath: string;
}

interface ValidatedExport {
  platform: OtaPlatform;
  appId: string;
  files: Map<string, ExportFile>;
  bundlePath: string;
  assetPaths: string[];
  assetExtensions: Map<string, string>;
  expoConfig: Record<string, unknown>;
}

interface UploadRequest {
  requestUploadUrl: string;
  fileName: string;
  filePath: string;
  headers?: Record<string, string>;
}

interface UploadLease {
  updateId: string;
  uploadRequests: UploadRequest[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// xprem derives update IDs from content hashes, so they have the 8-4-4-4-12 shape
// without RFC 4122 version and variant digits: production served
// `a96bbffc-e084-91c9-61ee-0107f5b6857b` on 2026-09-26. App IDs stay strict.
const UPDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

function object(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function string(input: unknown, label: string): string {
  if (typeof input !== 'string') throw new Error(`${label} must be a string.`);
  return input;
}

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

function normalizedPath(input: string): string {
  if (!input || input.includes('\0') || input.includes('\\') || isAbsolute(input) || /^[a-z]:[/\\]/i.test(input)) {
    throw new Error(`Unsafe Expo export path: ${JSON.stringify(input)}.`);
  }
  const segments = input.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Expo export path is not normalized: ${input}.`);
  }
  return input;
}

function regularExportFile(root: string, declaredPath: string): ExportFile {
  const relativePath = normalizedPath(declaredPath);
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    if (!existsSync(current)) throw new Error(`Expo export file is missing: ${relativePath}.`);
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`Expo export path contains a symbolic link: ${relativePath}.`);
  }
  if (!statSync(current).isFile()) throw new Error(`Expo export path is not a regular file: ${relativePath}.`);
  const relativeRealPath = relative(root, realpathSync(current));
  if (relativeRealPath === '..' || relativeRealPath.startsWith(`..${sep}`) || isAbsolute(relativeRealPath)) {
    throw new Error(`Expo export path escapes archive: ${relativePath}.`);
  }
  return { relativePath, absolutePath: current };
}

export function validateExport(
  exportDir: string,
  platform: OtaPlatform,
  expectedBundleSha256: string,
): ValidatedExport {
  const absoluteRoot = resolve(exportDir);
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory() || lstatSync(absoluteRoot).isSymbolicLink()) {
    throw new Error(`${platform} export directory is missing or symbolic.`);
  }
  const root = realpathSync(absoluteRoot);
  const metadataFile = regularExportFile(root, 'metadata.json');
  const expoConfigFile = regularExportFile(root, 'expoConfig.json');
  const metadata = object(JSON.parse(readFileSync(metadataFile.absolutePath, 'utf8')) as unknown, 'metadata.json');
  if (metadata.version !== 0 || metadata.bundler !== 'metro') throw new Error('Expo metadata must be Metro version 0.');
  const fileMetadata = object(metadata.fileMetadata, 'metadata.json fileMetadata');
  if (Object.keys(fileMetadata).length !== 1 || !(platform in fileMetadata)) {
    throw new Error(`${platform} export must contain exactly one platform's metadata.`);
  }
  const platformMetadata = object(fileMetadata[platform], `${platform} metadata`);
  const bundlePath = string(platformMetadata.bundle, `${platform} bundle`);
  if (!/\.(?:js|hbc)$/.test(bundlePath)) throw new Error(`${platform} bundle must be JavaScript or Hermes bytecode.`);
  if (!Array.isArray(platformMetadata.assets)) throw new Error(`${platform} metadata assets must be an array.`);

  const files = new Map<string, ExportFile>();
  const assetPaths: string[] = [];
  const assetExtensions = new Map<string, string>();
  const addFile = (declaredPath: string): void => {
    const file = regularExportFile(root, declaredPath);
    if (files.has(file.relativePath)) throw new Error(`Duplicate Expo export path: ${file.relativePath}.`);
    files.set(file.relativePath, file);
  };
  addFile('metadata.json');
  addFile('expoConfig.json');
  addFile(bundlePath);
  for (const [index, assetInput] of platformMetadata.assets.entries()) {
    const asset = object(assetInput, `${platform} asset ${index}`);
    const assetPath = string(asset.path, `${platform} asset ${index} path`);
    const extension = string(asset.ext, `${platform} asset ${index} ext`);
    // `expo export` writes assets under their content hash with no extension
    // (`assets/0a328cd9…`) and records the type in `ext`. Accept that shape, or a
    // path whose own extension agrees with `ext`; reject anything else.
    const assetName = assetPath.split('/').pop() ?? '';
    const dot = assetName.lastIndexOf('.');
    const shapeMatches = dot === -1 ? /^[0-9a-f]{32}$/i.test(assetName) : assetName.slice(dot + 1) === extension;
    if (!/^[a-z0-9]+$/i.test(extension) || !shapeMatches)
      throw new Error(`${platform} asset extension mismatch: ${assetPath}.`);
    addFile(assetPath);
    assetPaths.push(assetPath);
    assetExtensions.set(assetPath, extension);
  }

  const bundle = files.get(bundlePath);
  if (!bundle || statSync(bundle.absolutePath).size === 0) throw new Error(`${platform} bundle is empty.`);
  const actualHash = createHash('sha256').update(readFileSync(bundle.absolutePath)).digest('hex');
  if (actualHash !== expectedBundleSha256.toLowerCase())
    throw new Error(`${platform} bundle SHA-256 differs from stage receipt.`);

  const expoConfig = object(
    JSON.parse(readFileSync(expoConfigFile.absolutePath, 'utf8')) as unknown,
    'expoConfig.json',
  );
  const updates = object(expoConfig.updates, 'expoConfig.json updates');
  const requestHeaders = object(updates.requestHeaders, 'expoConfig.json updates.requestHeaders');
  const appId = string(requestHeaders['expo-app-id'], 'expo-app-id');
  if (!UUID.test(appId)) throw new Error('expo-app-id must be a UUID.');
  return { platform, appId, files, bundlePath, assetPaths, assetExtensions, expoConfig };
}

export function parsePromoteArgs(argv: string[]): { receipt: string; iosExport: string; androidExport: string } {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--') continue;
    if (!['--receipt', '--ios-export', '--android-export'].includes(flag))
      throw new Error(`Unknown argument: ${flag}.`);
    const argument = argv[++index];
    if (!argument || argument.startsWith('--')) throw new Error(`${flag} needs a path.`);
    args[flag] = argument;
  }
  if (!args['--receipt'] || !args['--ios-export'] || !args['--android-export']) {
    throw new Error('Provide --receipt, --ios-export, and --android-export.');
  }
  return { receipt: args['--receipt'], iosExport: args['--ios-export'], androidExport: args['--android-export'] };
}

export function parseCaptureArgs(argv: string[]): {
  appId: string;
  iosRuntime: string;
  androidRuntime: string;
  out: string;
} {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--capture-baseline') continue;
    if (!['--app-id', '--ios-runtime', '--android-runtime', '--out'].includes(flag)) {
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
  return { appId, iosRuntime, androidRuntime, out };
}

export function uploadServerBase(manifestUrl: string): URL {
  const parsed = new URL(manifestUrl);
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))
  ) {
    throw new Error('EXPO_UPDATES_URL must be HTTPS (HTTP is allowed only for localhost).');
  }
  if (!parsed.pathname.endsWith('/manifest') || parsed.search || parsed.hash) {
    throw new Error('EXPO_UPDATES_URL must end in /manifest without a query or fragment.');
  }
  parsed.pathname = parsed.pathname.slice(0, -'/manifest'.length);
  return parsed;
}

function controlUrl(base: URL, appId: string, action: string): URL {
  return new URL(`${base.toString().replace(/\/$/, '')}/${appId}/${action}/production`);
}

function isLocalUpload(target: URL, base: URL, appId: string): boolean {
  return (
    target.origin === base.origin && target.pathname === `${base.pathname.replace(/\/$/, '')}/${appId}/uploadLocalFile`
  );
}

function parseUploadLease(input: unknown, exportFiles: Map<string, ExportFile>, base: URL, appId: string): UploadLease {
  const lease = object(input, 'Upload lease');
  const updateIdRaw = lease.updateId;
  const updateId =
    typeof updateIdRaw === 'number' && Number.isSafeInteger(updateIdRaw)
      ? String(updateIdRaw)
      : typeof updateIdRaw === 'string' && /^\d+$/.test(updateIdRaw)
        ? updateIdRaw
        : null;
  if (!updateId) throw new Error('Upload lease has no valid updateId.');
  if (!Array.isArray(lease.uploadRequests)) throw new Error('Upload lease has no uploadRequests array.');
  const seen = new Set<string>();
  const uploadRequests = lease.uploadRequests.map((itemInput, index): UploadRequest => {
    const item = object(itemInput, `Upload request ${index}`);
    const filePath = string(item.filePath, `Upload request ${index} filePath`);
    const fileName = string(item.fileName, `Upload request ${index} fileName`);
    if (!exportFiles.has(filePath) || normalizedPath(filePath) !== filePath || fileName !== basename(filePath)) {
      throw new Error(`Upload request ${index} is not an exported file: ${filePath}.`);
    }
    if (seen.has(filePath)) throw new Error(`Duplicate upload request for ${filePath}.`);
    seen.add(filePath);
    const requestUploadUrl = string(item.requestUploadUrl, `Upload request ${index} URL`);
    const target = new URL(requestUploadUrl);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLocalUpload(target, base, appId))) {
      throw new Error(`Upload request ${index} uses an unsafe URL.`);
    }
    if (target.username || target.password || target.hash)
      throw new Error(`Upload request ${index} URL has unsafe components.`);
    let headers: Record<string, string> | undefined;
    if (item.headers !== undefined) {
      const rawHeaders = object(item.headers, `Upload request ${index} headers`);
      headers = {};
      for (const [key, header] of Object.entries(rawHeaders)) {
        if (!/^[A-Za-z0-9-]+$/.test(key) || typeof header !== 'string' || /[\r\n]/.test(header)) {
          throw new Error(`Upload request ${index} has an invalid header.`);
        }
        headers[key] = header;
      }
    }
    return { requestUploadUrl, fileName, filePath, headers };
  });
  // xprem 3.1.2 reuses matching assets from the previous production update;
  // uploadRequests can legitimately be only a subset of requested files.
  return { updateId, uploadRequests };
}

function contentType(filePath: string, assetExtension?: string): string {
  const extension = (assetExtension ?? filePath.split('.').pop())?.toLowerCase();
  if (extension === 'json' || extension === 'map') return 'application/json';
  if (extension === 'js') return 'application/javascript';
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'ttf') return 'font/ttf';
  if (extension === 'otf') return 'font/otf';
  return 'application/octet-stream';
}

async function requireSuccess(response: Response, action: string): Promise<void> {
  if (!response.ok) throw new Error(`${action} failed (${response.status}): ${(await response.text()).slice(0, 300)}.`);
}

const sleep = (delayMs: number): Promise<void> => new Promise((done) => setTimeout(done, delayMs));

async function fetchWithRetry(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | (() => RequestInit),
  beforeAttempt?: () => Promise<void>,
): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await beforeAttempt?.();
      // Multipart bodies are streams. Rebuild them for each local-bucket retry.
      const response = await fetchImpl(input, typeof init === 'function' ? init() : init);
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === 3) return response;
      await response.body?.cancel();
      const retryAfterSeconds = Number(response.headers.get('Retry-After'));
      const delayMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(retryAfterSeconds * 1_000, 10_000)
          : 1_000 * 2 ** attempt;
      await sleep(delayMs);
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(1_000 * 2 ** attempt);
    }
  }
  throw new Error('OTA request retry loop exhausted.');
}

async function uploadLeaseFiles(
  lease: UploadLease,
  exportFiles: ValidatedExport,
  base: URL,
  appId: string,
  token: string,
  fetchImpl: typeof fetch,
  paceUpload: () => Promise<void>,
): Promise<void> {
  for (const request of lease.uploadRequests) {
    const file = exportFiles.files.get(request.filePath);
    if (!file) throw new Error(`Unvalidated upload file: ${request.filePath}.`);
    const bytes = readFileSync(file.absolutePath);
    if (isLocalUpload(new URL(request.requestUploadUrl), base, appId)) {
      await requireSuccess(
        await fetchWithRetry(
          fetchImpl,
          request.requestUploadUrl,
          () => {
            const form = new FormData();
            form.append(request.fileName, new Blob([bytes]), request.fileName);
            return {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}` },
              body: form,
              redirect: 'error',
            };
          },
          paceUpload,
        ),
        `Local upload ${request.filePath}`,
      );
    } else {
      await requireSuccess(
        await fetchWithRetry(
          fetchImpl,
          request.requestUploadUrl,
          {
            method: 'PUT',
            headers: {
              'Content-Type': contentType(request.filePath, exportFiles.assetExtensions.get(request.filePath)),
              'Cache-Control': 'max-age=31556926',
              ...request.headers,
            },
            body: bytes,
            redirect: 'error',
          },
          paceUpload,
        ),
        `Asset upload ${request.filePath}`,
      );
    }
  }
}

function parseServedManifest(responseText: string): Record<string, unknown> | null {
  // xprem serves multipart/mixed for signed manifests, plain JSON for others.
  // A recognized noUpdateAvailable directive is the only evidence of absence.
  let noUpdateAvailable = false;
  for (const part of responseText.split(/\r?\n--[^\r\n]+/)) {
    const body = part.includes('\r\n\r\n') ? part.slice(part.indexOf('\r\n\r\n') + 4).trim() : part.trim();
    let candidate: Record<string, unknown>;
    try {
      candidate = object(JSON.parse(body) as unknown, 'Manifest');
    } catch {
      // Multipart signature and metadata parts are not update manifests.
      continue;
    }
    if (candidate.launchAsset !== undefined) return candidate;
    if (candidate.type === 'noUpdateAvailable') noUpdateAvailable = true;
    if (candidate.type === 'rollBackToEmbedded') throw new Error('Production is serving a rollback directive.');
  }
  if (noUpdateAvailable) return null;
  throw new Error('Production did not serve an Expo update manifest.');
}

async function readProductionManifest(
  manifestUrl: string,
  platform: OtaPlatform,
  runtimeVersion: string,
  appId: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  const response = await fetchWithRetry(fetchImpl, manifestUrl, {
    method: 'GET',
    headers: {
      'expo-protocol-version': '1',
      'expo-platform': platform,
      'expo-runtime-version': runtimeVersion,
      'expo-channel-name': 'production',
      'expo-app-id': appId,
      'xprem-branch': '',
      Accept: 'multipart/mixed',
    },
    redirect: 'error',
  });
  await requireSuccess(response, `${platform} production manifest probe`);
  const manifest = parseServedManifest(await response.text());
  if (manifest === null) return null;
  if (manifest.runtimeVersion !== runtimeVersion)
    throw new Error(`${platform} production runtimeVersion differs from staged runtime.`);
  const extra = object(manifest.extra, 'Production manifest extra');
  if (extra.branch !== 'production') throw new Error(`${platform} manifest is not from the production branch.`);
  return manifest;
}

async function productionUpdateId(
  manifestUrl: string,
  platform: OtaPlatform,
  runtimeVersion: string,
  appId: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const manifest = await readProductionManifest(manifestUrl, platform, runtimeVersion, appId, fetchImpl);
  if (manifest === null) return null;
  const id = string(manifest.id, `${platform} production update ID`);
  if (!UPDATE_ID.test(id)) throw new Error(`${platform} production update ID must be a UUID-shaped ID.`);
  return id;
}

export async function captureProductionBaseline(options: {
  manifestUrl: string;
  appId: string;
  runtimeVersions: Record<OtaPlatform, string>;
  fetchImpl?: typeof fetch;
}): Promise<Record<OtaPlatform, string | null>> {
  if (!UUID.test(options.appId)) throw new Error('Capture app ID must be a UUID.');
  uploadServerBase(options.manifestUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
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
    );
  }
  return baseline;
}

async function verifyServedExport(
  manifestUrl: string,
  exportFiles: ValidatedExport,
  runtimeVersion: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const manifest = await readProductionManifest(
    manifestUrl,
    exportFiles.platform,
    runtimeVersion,
    exportFiles.appId,
    fetchImpl,
  );
  if (manifest === null) throw new Error(`${exportFiles.platform} production has no update after promotion.`);
  const extra = object(manifest.extra, 'Production manifest extra');
  if (!isDeepStrictEqual(extra.expoClient, exportFiles.expoConfig)) {
    throw new Error(`${exportFiles.platform} production Expo config differs from stage.`);
  }
  const launchAsset = object(manifest.launchAsset, 'Production launchAsset');
  const bundleFile = exportFiles.files.get(exportFiles.bundlePath);
  if (!bundleFile) throw new Error(`${exportFiles.platform} export bundle disappeared.`);
  const bundleHash = createHash('sha256').update(readFileSync(bundleFile.absolutePath)).digest('base64url');
  if (launchAsset.hash !== bundleHash)
    throw new Error(`${exportFiles.platform} production bundle hash differs from stage.`);
  if (!Array.isArray(manifest.assets))
    throw new Error(`${exportFiles.platform} production manifest has no asset list.`);
  const servedHashes = manifest.assets
    .map((assetInput: unknown) => string(object(assetInput, 'Production asset').hash, 'Production asset hash'))
    .sort();
  const stagedHashes = exportFiles.assetPaths
    .map((assetPath) => {
      const asset = exportFiles.files.get(assetPath);
      if (!asset) throw new Error(`${exportFiles.platform} staged asset disappeared: ${assetPath}.`);
      return createHash('sha256').update(readFileSync(asset.absolutePath)).digest('base64url');
    })
    .sort();
  if (JSON.stringify(servedHashes) !== JSON.stringify(stagedHashes)) {
    throw new Error(`${exportFiles.platform} production asset hashes differ from stage.`);
  }
}

async function verifyServedExportWithRetry(
  manifestUrl: string,
  exportFiles: ValidatedExport,
  runtimeVersion: string,
  fetchImpl: typeof fetch,
  delaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      await verifyServedExport(manifestUrl, exportFiles, runtimeVersion, fetchImpl);
      return;
    } catch (error) {
      if (attempt === delaysMs.length) throw error;
      console.warn(`[ota-promote] ${exportFiles.platform}: production manifest not yet confirmed; retrying.`);
      await sleep(delaysMs[attempt]);
    }
  }
}

export async function promoteArchivedOta(options: {
  receiptPath: string;
  iosExport: string;
  androidExport: string;
  manifestUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  verificationDelaysMs?: readonly number[];
}): Promise<void> {
  if (!options.token) throw new Error('EOO_TOKEN is required.');
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
  const publishGroup = randomUUID();
  const leases = {} as Record<OtaPlatform, UploadLease>;
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
    );
    if (current !== expected) {
      throw new Error(
        `${platform} production update changed since staging began ` +
          `(baseline ${expected ?? 'none'}, current ${current ?? 'none'}); refusing stale OTA promotion.`,
      );
    }
  };

  // Both platforms must still match their pre-stage baseline before creating
  // either production upload lease. A no-update directive is an explicit null;
  // malformed responses and rollback directives are never treated as null.
  await assertBaselineUnchanged('ios');
  await assertBaselineUnchanged('android');

  // Validate both server responses before sending any archived bytes.
  for (const platform of ['ios', 'android'] as const) {
    const requestUrl = controlUrl(base, appId, 'requestUploadUrl');
    requestUrl.searchParams.set('runtimeVersion', receipt.platforms[platform].runtimeVersion);
    requestUrl.searchParams.set('platform', platform);
    requestUrl.searchParams.set('commitHash', receipt.commitHash);
    requestUrl.searchParams.set('publishGroup', publishGroup);
    const response = await fetchWithRetry(fetchImpl, requestUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileNames: [...exports[platform].files.keys()],
        ...(receipt.message ? { message: receipt.message } : {}),
      }),
      redirect: 'error',
    });
    await requireSuccess(response, `${platform} upload request`);
    leases[platform] = parseUploadLease((await response.json()) as unknown, exports[platform].files, base, appId);
  }

  for (const platform of ['ios', 'android'] as const) {
    // Recheck immediately before each platform's first production PUT.
    await assertBaselineUnchanged(platform);
    await uploadLeaseFiles(leases[platform], exports[platform], base, appId, options.token, fetchImpl, paceUpload);
    const finalizeUrl = controlUrl(base, appId, 'markUpdateAsUploaded');
    finalizeUrl.searchParams.set('platform', platform);
    finalizeUrl.searchParams.set('updateId', leases[platform].updateId);
    finalizeUrl.searchParams.set('runtimeVersion', receipt.platforms[platform].runtimeVersion);
    const response = await fetchWithRetry(fetchImpl, finalizeUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      redirect: 'error',
    });
    if (response.status === 409)
      throw new Error(`${platform} production has an active rollout; promotion was refused.`);
    if (response.status !== 406) await requireSuccess(response, `${platform} production finalize`);
    await verifyServedExportWithRetry(
      options.manifestUrl,
      exports[platform],
      receipt.platforms[platform].runtimeVersion,
      fetchImpl,
      options.verificationDelaysMs ?? [1_000, 2_000, 4_000, 8_000],
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
    });
    writeFileSync(args.out, `${JSON.stringify(baseline)}\n`, { flag: 'wx' });
    console.log(`[ota-promote] Captured production baseline: ${args.out}`);
    return;
  }
  const args = parsePromoteArgs(process.argv.slice(2));
  await promoteArchivedOta({
    receiptPath: args.receipt,
    iosExport: args.iosExport,
    androidExport: args.androidExport,
    manifestUrl: process.env.EXPO_UPDATES_URL ?? '',
    token: process.env.EOO_TOKEN ?? '',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`[ota-promote] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
