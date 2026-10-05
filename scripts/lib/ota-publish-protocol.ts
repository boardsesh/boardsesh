/// <reference types="node" />

/**
 * The xprem publish protocol, as eoas 3.2.5 speaks it: validate an Expo export on
 * disk, ask the server for an upload lease, send the files, finalize, and read
 * what a device is then served. One copy, shared by the two tools that publish
 * without running `expo export`:
 *
 *   - scripts/mobile-ota-promote.ts promotes main's archived export.
 *   - scripts/ota-rollout-proof.ts publishes synthetic updates to a scratch
 *     branch to exercise the rollout calls.
 *
 * Every request here is authenticated with the publish token (`EOO_TOKEN`),
 * except the manifest read, which is the anonymous device endpoint.
 *
 * The protocol changed at 3.2.0: requestUploadUrl takes a `files` list (path,
 * content hash, md5 cache key and role) instead of `fileNames`, and a server on
 * either side of that line rejects the other shape, so this file moves with
 * EOAS_PACKAGE_SPEC.
 *
 * Dependency-free with `.ts` import extensions: run under bare
 * `node --experimental-strip-types` by jobs that hold a publish credential.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type OtaPlatform = 'ios' | 'android';

export interface ExportFile {
  relativePath: string;
  absolutePath: string;
}

export interface ValidatedExport {
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

export interface UploadLease {
  updateId: string;
  uploadRequests: UploadRequest[];
}

/** What a published file is to the update, as the server reads it (eoas 3.2.4 FileRole). */
export type UploadFileRole = 'launch' | 'asset' | 'config';

/** One entry of the requestUploadUrl `files` list (eoas 3.2.4 FileUploadItem). */
export interface UploadFileItem {
  path: string;
  /** SHA-256, base64url without padding: the manifest hash and the object key under {appId}/cas/. */
  hash: string;
  /** MD5 hex: the on-device cache key expo-updates uses. Absent for config files. */
  key?: string;
  ext?: string;
  role: UploadFileRole;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// xprem derives update IDs from content hashes, so they have the 8-4-4-4-12 shape
// without RFC 4122 version and variant digits: production served
// `a96bbffc-e084-91c9-61ee-0107f5b6857b` on 2026-09-26. App IDs stay strict.
export const UPDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The channel every binary bakes into `expo-channel-name`. Every probe goes
 * through it, whatever branch it targets: a branch other than the channel's own
 * is reached with the `xprem-branch` header, never with another channel.
 */
export const CHANNEL = 'production';

/** The branch the channel maps to, and the target when no branch is named. */
export const DEFAULT_BRANCH = 'production';

/** The branch as it starts a sentence. `Production` for the default, so its messages are unchanged. */
export function sentenceLabel(branch: string): string {
  return branch === DEFAULT_BRANCH ? 'Production' : `Branch ${branch}`;
}

export function object(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  return input as Record<string, unknown>;
}

export function string(input: unknown, label: string): string {
  if (typeof input !== 'string') throw new Error(`${label} must be a string.`);
  return input;
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

function fileDigest(absolutePath: string): { hash: string; key: string } {
  const bytes = readFileSync(absolutePath);
  return {
    hash: createHash('sha256').update(bytes).digest('base64url'),
    key: createHash('md5').update(bytes).digest('hex'),
  };
}

/**
 * The `files` list eoas 3.2.4 sends for one platform (buildUploadFiles +
 * computeFilesRequests): the two config files, the launch bundle and each asset,
 * each with its digest and role. The server validates every entry and refuses a
 * publish without exactly one launch asset.
 */
export function buildUploadFiles(exportFiles: ValidatedExport): UploadFileItem[] {
  const fileAt = (relativePath: string): ExportFile => {
    const file = exportFiles.files.get(relativePath);
    if (!file) throw new Error(`${exportFiles.platform} export file disappeared: ${relativePath}.`);
    return file;
  };
  const configFiles = ['metadata.json', 'expoConfig.json'].map((relativePath): UploadFileItem => ({
    path: relativePath,
    hash: fileDigest(fileAt(relativePath).absolutePath).hash,
    role: 'config',
  }));
  const launchAsset: UploadFileItem = {
    path: exportFiles.bundlePath,
    ...fileDigest(fileAt(exportFiles.bundlePath).absolutePath),
    // eoas stamps every launch bundle `hbc`, whatever its path says.
    ext: 'hbc',
    role: 'launch',
  };
  const assets = exportFiles.assetPaths.map((assetPath): UploadFileItem => ({
    path: assetPath,
    ...fileDigest(fileAt(assetPath).absolutePath),
    ext: exportFiles.assetExtensions.get(assetPath),
    role: 'asset',
  }));
  return [...configFiles, launchAsset, ...assets];
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

function controlUrl(base: URL, appId: string, action: string, branch: string): URL {
  return new URL(`${base.toString().replace(/\/$/, '')}/${appId}/${action}/${branch}`);
}

function isLocalUpload(target: URL, base: URL, appId: string): boolean {
  return (
    target.origin === base.origin && target.pathname === `${base.pathname.replace(/\/$/, '')}/${appId}/uploadLocalFile`
  );
}

export function parseUploadLease(
  input: unknown,
  exportFiles: Map<string, ExportFile>,
  base: URL,
  appId: string,
): UploadLease {
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
  // xprem stores files by content hash and skips any it already holds, so
  // uploadRequests can legitimately be only a subset of requested files.
  return { updateId, uploadRequests };
}

function contentType(filePath: string, assetExtension?: string): string {
  const extension = (assetExtension ?? filePath.split('.').pop())?.toLowerCase();
  if (extension === 'json' || extension === 'map') return 'application/json';
  if (extension === 'xml') return 'application/xml';
  if (extension === 'js') return 'application/javascript';
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'ttf') return 'font/ttf';
  if (extension === 'otf') return 'font/otf';
  return 'application/octet-stream';
}

export async function requireSuccess(response: Response, action: string): Promise<void> {
  if (!response.ok) throw new Error(`${action} failed (${response.status}): ${(await response.text()).slice(0, 300)}.`);
}

export const sleep = (delayMs: number): Promise<void> => new Promise((done) => setTimeout(done, delayMs));

export async function fetchWithRetry(
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

/** Where one publish goes and who is asking. */
export interface PublishTarget {
  base: URL;
  appId: string;
  branch: string;
  token: string;
  fetchImpl: typeof fetch;
}

/**
 * `POST {base}/{appId}/requestUploadUrl/{branch}`: ask for an upload lease for one
 * platform. Returns the raw response: 409 is a live rollout, 406 means the branch
 * already serves exactly these files, and both are the caller's to interpret.
 */
export function requestUploadLease(
  target: PublishTarget,
  publish: {
    platform: OtaPlatform;
    runtimeVersion: string;
    commitHash: string;
    publishGroup: string;
    /** Start the update as a rollout to this share of devices. Null publishes to everyone. */
    rolloutPercentage: number | null;
    files: UploadFileItem[];
    message: string;
  },
): Promise<Response> {
  const requestUrl = controlUrl(target.base, target.appId, 'requestUploadUrl', target.branch);
  requestUrl.searchParams.set('runtimeVersion', publish.runtimeVersion);
  requestUrl.searchParams.set('platform', publish.platform);
  requestUrl.searchParams.set('commitHash', publish.commitHash);
  requestUrl.searchParams.set('publishGroup', publish.publishGroup);
  if (publish.rolloutPercentage !== null) {
    requestUrl.searchParams.set('rolloutPercentage', String(publish.rolloutPercentage));
  }
  return fetchWithRetry(target.fetchImpl, requestUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: publish.files,
      ...(publish.message ? { message: publish.message } : {}),
    }),
    redirect: 'error',
  });
}

/** Send every file the lease asked for, to the bucket or to the server's local-bucket route. */
export async function uploadLeaseFiles(
  lease: UploadLease,
  exportFiles: ValidatedExport,
  target: Omit<PublishTarget, 'branch'>,
  paceUpload: () => Promise<void>,
): Promise<void> {
  const { base, appId, token, fetchImpl } = target;
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
              // Since 3.2.0 the local-bucket upload token travels in a header the
              // lease names, alongside the publish credential.
              headers: { ...request.headers, Authorization: `Bearer ${token}` },
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

/**
 * `POST {base}/{appId}/markUpdateAsUploaded/{branch}`: make an uploaded update
 * visible. Returns the raw response: 409 is a live rollout, 406 a duplicate.
 */
export function finalizeUpload(
  target: PublishTarget,
  update: { platform: OtaPlatform; runtimeVersion: string; updateId: string },
): Promise<Response> {
  const finalizeUrl = controlUrl(target.base, target.appId, 'markUpdateAsUploaded', target.branch);
  finalizeUrl.searchParams.set('platform', update.platform);
  finalizeUrl.searchParams.set('updateId', update.updateId);
  finalizeUrl.searchParams.set('runtimeVersion', update.runtimeVersion);
  return fetchWithRetry(target.fetchImpl, finalizeUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
    redirect: 'error',
  });
}

/**
 * `POST {base}/{appId}/republish/{branch}`: publish an existing update again as a
 * new one, the single-update call `eoas republish` ends with (eoas 3.2.5
 * commands/republish.js). `updateId` is the numeric id.
 */
export function requestRepublish(
  target: PublishTarget,
  update: { platform: OtaPlatform; runtimeVersion: string; updateId: string; commitHash: string },
): Promise<Response> {
  const republishUrl = controlUrl(target.base, target.appId, 'republish', target.branch);
  republishUrl.searchParams.set('platform', update.platform);
  republishUrl.searchParams.set('runtimeVersion', update.runtimeVersion);
  republishUrl.searchParams.set('updateId', update.updateId);
  republishUrl.searchParams.set('commitHash', update.commitHash);
  return fetchWithRetry(target.fetchImpl, republishUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.token}`, 'use-cli-auth': 'true', 'Content-Type': 'application/json' },
    redirect: 'error',
  });
}

/**
 * `POST {base}/{appId}/rollback/{branch}`: publish a roll-back-to-embedded
 * directive, the call `eoas rollback` makes (eoas 3.2.5 commands/rollback.js).
 */
export function requestRollbackToEmbedded(
  target: PublishTarget,
  rollback: { platform: OtaPlatform; runtimeVersion: string; commitHash: string },
): Promise<Response> {
  const rollbackUrl = controlUrl(target.base, target.appId, 'rollback', target.branch);
  rollbackUrl.searchParams.set('commitHash', rollback.commitHash);
  rollbackUrl.searchParams.set('platform', rollback.platform);
  rollbackUrl.searchParams.set('runtimeVersion', rollback.runtimeVersion);
  return fetchWithRetry(target.fetchImpl, rollbackUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.token}` },
    redirect: 'error',
  });
}

/** What one manifest response holds, without judging it. */
export type ServedManifest =
  | { kind: 'update'; manifest: Record<string, unknown> }
  | { kind: 'noUpdateAvailable' }
  | { kind: 'rollBackToEmbedded' }
  | { kind: 'unrecognized' };

/**
 * Read a manifest response body. xprem serves multipart/mixed for signed
 * manifests and plain JSON for others. A recognized noUpdateAvailable directive
 * is the only evidence of absence.
 */
export function classifyServedManifest(responseText: string): ServedManifest {
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
    if (candidate.launchAsset !== undefined) return { kind: 'update', manifest: candidate };
    if (candidate.type === 'noUpdateAvailable') noUpdateAvailable = true;
    if (candidate.type === 'rollBackToEmbedded') return { kind: 'rollBackToEmbedded' };
  }
  return noUpdateAvailable ? { kind: 'noUpdateAvailable' } : { kind: 'unrecognized' };
}

/** The update manifest a response serves, null for "no update", and an error for anything else. */
export function parseServedManifest(responseText: string, branch: string): Record<string, unknown> | null {
  const served = classifyServedManifest(responseText);
  if (served.kind === 'update') return served.manifest;
  if (served.kind === 'noUpdateAvailable') return null;
  if (served.kind === 'rollBackToEmbedded')
    throw new Error(`${sentenceLabel(branch)} is serving a rollback directive.`);
  throw new Error(`${sentenceLabel(branch)} did not serve an Expo update manifest.`);
}

/**
 * The request a device makes: `GET {manifestUrl}` with the headers a store binary
 * bakes in. `easClientId` is the persistent device id a real device sends; a
 * rollout buckets on it, and a request without one is never in a rollout.
 */
export function requestManifest(options: {
  manifestUrl: string;
  platform: OtaPlatform;
  runtimeVersion: string;
  appId: string;
  branch: string;
  easClientId?: string;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  return fetchWithRetry(options.fetchImpl, options.manifestUrl, {
    method: 'GET',
    headers: {
      'expo-protocol-version': '1',
      'expo-platform': options.platform,
      'expo-runtime-version': options.runtimeVersion,
      'expo-channel-name': CHANNEL,
      'expo-app-id': options.appId,
      // Empty asks for the channel's own branch, which is what a store binary
      // sends. Any other branch is surfed to by name, the way a device pinned to
      // it would.
      'xprem-branch': options.branch === DEFAULT_BRANCH ? '' : options.branch,
      ...(options.easClientId === undefined ? {} : { 'EAS-Client-ID': options.easClientId }),
      Accept: 'multipart/mixed',
    },
    redirect: 'error',
  });
}
