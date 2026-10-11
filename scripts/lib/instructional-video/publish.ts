import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { STATIC_ASSET_ORIGIN } from '../../../packages/shared/static-assets/src';
import { readResponseBodyWithinLimit, STATIC_ASSET_CACHE_CONTROL } from '../static-asset-upload';
import type { TutorialPlatform, TutorialTakeManifest } from './types';

export type TutorialBundleAsset = Readonly<{
  filename: string;
  kind: 'video' | 'cover' | 'subtitles' | 'chapters' | 'caption';
  sha256: string;
  bytes: number;
  contentType: string;
  cutId?: string;
}>;
export type TutorialBundle = Readonly<{
  formatVersion: 1;
  episodeId: string;
  title: string;
  platform: TutorialPlatform;
  draft: boolean;
  sourceRef?: string;
  createdAt: string;
  cuts: readonly Readonly<{ id: string; kind: string; seconds: number }>[];
  assets: readonly TutorialBundleAsset[];
  captureProvenance: readonly TutorialTakeManifest[];
}>;
export type PublishedTutorialAsset = TutorialBundleAsset & Readonly<{ key: string; url: string }>;
export type TutorialPublicationPlan = Readonly<{
  bundle: TutorialBundle;
  assets: readonly PublishedTutorialAsset[];
  editionKey: string;
  editionUrl: string;
  editionSha256: string;
  latestKey: string;
  latestUrl: string;
  editionBytes: Buffer;
  latestBytes: Buffer;
}>;
export type TutorialPublisherTransport = Readonly<{
  putImmutable: (key: string, body: Buffer, contentType: string) => Promise<void>;
  putLatest: (key: string, body: Buffer) => Promise<void>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}>;
export type TutorialPublishOptions = Readonly<{
  dryRun?: boolean;
  environment?: NodeJS.ProcessEnv;
  transport?: TutorialPublisherTransport;
}>;

const IDENTIFIER = /^[a-z0-9][a-z0-9.-]{0,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONTENT_TYPES = {
  video: 'video/mp4',
  cover: 'image/webp',
  subtitles: 'text/vtt',
  chapters: 'application/json',
  caption: 'text/plain',
} as const;
const EXTENSIONS = { video: '.mp4', cover: '.webp', subtitles: '.vtt', chapters: '.json', caption: '.txt' } as const;
const POINTER_CACHE_CONTROL = 'public, max-age=60, must-revalidate';

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
function string(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0;
}
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Validate authoring output before either opening a credential or writing a remote object. */
export function validateTutorialBundle(input: unknown): TutorialBundle {
  if (
    !record(input) ||
    input.formatVersion !== 1 ||
    !string(input.episodeId) ||
    !IDENTIFIER.test(input.episodeId) ||
    !string(input.title) ||
    !['android', 'ios'].includes(String(input.platform)) ||
    typeof input.draft !== 'boolean' ||
    !string(input.createdAt) ||
    !Number.isFinite(Date.parse(input.createdAt))
  )
    throw new Error('Invalid tutorial bundle header');
  if (input.draft)
    throw new Error('Draft tutorial bundles cannot be published; record all voiceovers and add music first');
  if (input.episodeId !== 'evergreen' && (!string(input.sourceRef) || !/^[a-f0-9]{40}$/.test(input.sourceRef)))
    throw new Error('Release tutorials require a resolved 40-character shipped sourceRef');
  if (
    !Array.isArray(input.cuts) ||
    input.cuts.length === 0 ||
    input.cuts.some(
      (cut: unknown) =>
        !record(cut) ||
        !string(cut.id) ||
        !IDENTIFIER.test(cut.id) ||
        !string(cut.kind) ||
        typeof cut.seconds !== 'number' ||
        !Number.isFinite(cut.seconds) ||
        cut.seconds <= 0,
    )
  )
    throw new Error('Invalid tutorial cuts');
  if (!Array.isArray(input.assets) || input.assets.length === 0) throw new Error('Tutorial bundle has no assets');
  const filenames = new Set<string>();
  for (const asset of input.assets as unknown[]) {
    if (
      !record(asset) ||
      !string(asset.filename) ||
      asset.filename !== basename(asset.filename) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(asset.filename) ||
      !string(asset.kind) ||
      !Object.hasOwn(CONTENT_TYPES, asset.kind) ||
      !string(asset.sha256) ||
      !HASH.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      Number(asset.bytes) < 1 ||
      !string(asset.contentType)
    )
      throw new Error('Invalid tutorial asset or unsafe filename');
    const kind = asset.kind as TutorialBundleAsset['kind'];
    if (asset.contentType.split(';')[0].trim() !== CONTENT_TYPES[kind] || extname(asset.filename) !== EXTENSIONS[kind])
      throw new Error(`Tutorial asset type mismatch: ${asset.filename}`);
    if (filenames.has(asset.filename)) throw new Error(`Duplicate tutorial asset: ${asset.filename}`);
    filenames.add(asset.filename);
    if (asset.cutId !== undefined && (!string(asset.cutId) || !IDENTIFIER.test(asset.cutId)))
      throw new Error(`Invalid cutId: ${asset.filename}`);
  }
  const bundle = input as unknown as TutorialBundle;
  if (new Set(bundle.cuts.map((cut) => cut.id)).size !== bundle.cuts.length)
    throw new Error('Duplicate tutorial cut IDs');
  for (const cut of bundle.cuts) {
    for (const kind of ['video', 'cover', 'subtitles', 'chapters', 'caption'] as const)
      if (!bundle.assets.some((asset) => asset.cutId === cut.id && asset.kind === kind))
        throw new Error(`Tutorial ${cut.id} is missing ${kind}`);
  }
  for (const kind of ['chapters', 'caption'] as const)
    if (!bundle.assets.some((asset) => asset.kind === kind)) throw new Error(`Tutorial bundle is missing ${kind}`);
  if (
    !Array.isArray(bundle.captureProvenance) ||
    bundle.captureProvenance.length === 0 ||
    bundle.captureProvenance.some(
      (capture) =>
        !record(capture) ||
        capture.platform !== bundle.platform ||
        !string(capture.sourceCommit) ||
        !string(capture.nativeArtifactSha256) ||
        !HASH.test(capture.nativeArtifactSha256) ||
        !string(capture.fingerprint) ||
        !HASH.test(capture.fingerprint),
    )
  )
    throw new Error('Tutorial bundle requires native capture provenance');
  const cutIds = new Set(bundle.cuts.map((cut) => cut.id));
  if (bundle.assets.some((asset) => !asset.cutId || !cutIds.has(asset.cutId)))
    throw new Error('Every tutorial asset must belong to a declared cut');
  if (
    bundle.episodeId !== 'evergreen' &&
    bundle.captureProvenance.some((capture) => capture.sourceCommit !== bundle.sourceRef)
  )
    throw new Error('Release tutorial native captures do not match the shipped sourceRef');
  if (bundle.episodeId !== 'evergreen' && bundle.captureProvenance.some((capture) => capture.sourceDirty !== false))
    throw new Error('Release tutorial native captures require verified clean app sources');
  return bundle;
}

async function verifyLocalAsset(directory: string, asset: TutorialBundleAsset): Promise<void> {
  const path = resolve(directory, asset.filename);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== asset.bytes)
    throw new Error(`Tutorial file missing, unsafe, or changed size: ${asset.filename}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) throw new Error(`Tutorial file checksum changed: ${asset.filename}`);
}

export async function planTutorialPublication(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TutorialPublicationPlan> {
  const bundle = validateTutorialBundle(
    JSON.parse(await readFile(resolve(directory, 'bundle.json'), 'utf8')) as unknown,
  );
  for (const asset of bundle.assets) await verifyLocalAsset(directory, asset);
  const publicBase = (environment.STATIC_ASSETS_PUBLIC_BASE_URL?.trim() || STATIC_ASSET_ORIGIN).replace(/\/+$/, '');
  if (new URL(publicBase).protocol !== 'https:') throw new Error('Tutorial CDN public URL must use HTTPS');
  const prefix = `tutorials/v1/${bundle.episodeId}/${bundle.platform}`;
  const assets = bundle.assets.map((asset) => {
    const key = `${prefix}/objects/${asset.sha256}${extname(asset.filename)}`;
    return { ...asset, key, url: `${publicBase}/${key}` };
  });
  const editionBytes = Buffer.from(`${JSON.stringify({ ...bundle, assets }, null, 2)}\n`);
  const editionSha256 = sha256(editionBytes);
  const editionKey = `${prefix}/editions/${editionSha256}.json`;
  const editionUrl = `${publicBase}/${editionKey}`;
  const latestKey = `${prefix}/latest.json`;
  const latestUrl = `${publicBase}/${latestKey}`;
  const latestBytes = Buffer.from(
    `${JSON.stringify({ formatVersion: 1, episodeId: bundle.episodeId, platform: bundle.platform, editionKey, editionUrl, editionSha256, updatedAt: bundle.createdAt }, null, 2)}\n`,
  );
  return { bundle, assets, editionKey, editionUrl, editionSha256, latestKey, latestUrl, editionBytes, latestBytes };
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const configured = environment[name]?.trim();
  if (!configured) throw new Error(`Missing ${name}`);
  return configured;
}

export function createTutorialS3Client(
  environment: NodeJS.ProcessEnv,
  requestHandler?: S3ClientConfig['requestHandler'],
): S3Client {
  const endpoint = requiredEnvironment(environment, 'STATIC_ASSETS_AWS_ENDPOINT_URL');
  if (new URL(endpoint).protocol !== 'https:') throw new Error('Tutorial asset S3 endpoint must use HTTPS');
  return new S3Client({
    endpoint,
    region: requiredEnvironment(environment, 'STATIC_ASSETS_AWS_REGION'),
    credentials: {
      accessKeyId: requiredEnvironment(environment, 'STATIC_ASSETS_AWS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment(environment, 'STATIC_ASSETS_AWS_SECRET_ACCESS_KEY'),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(requestHandler ? { requestHandler } : {}),
    maxAttempts: 5,
  });
}

export function tutorialPutObjectInput(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
  cacheControl: string,
  immutable: boolean,
): PutObjectCommandInput {
  return {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
    ContentMD5: createHash('md5').update(body).digest('base64'),
    Metadata: { sha256: sha256(body) },
    ...(immutable ? { IfNoneMatch: '*' } : {}),
  };
}

function s3Transport(environment: NodeJS.ProcessEnv): TutorialPublisherTransport {
  const bucket = requiredEnvironment(environment, 'STATIC_ASSETS_S3_BUCKET_NAME');
  const client = createTutorialS3Client(environment);
  const put = async (
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl: string,
    immutable: boolean,
  ): Promise<void> => {
    const checksum = sha256(body);
    if (immutable) {
      try {
        const existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        if (
          existing.ContentLength !== body.byteLength ||
          existing.ContentType !== contentType ||
          existing.CacheControl !== cacheControl ||
          (existing.Metadata?.sha256 && existing.Metadata.sha256 !== checksum)
        )
          throw new Error(`Existing immutable tutorial object differs: ${key}`);
        return;
      } catch (error: unknown) {
        const status = record(error) && record(error.$metadata) ? error.$metadata.httpStatusCode : undefined;
        if (status !== 404 && !(error instanceof Error && ['NotFound', 'NoSuchKey'].includes(error.name))) throw error;
      }
    }
    try {
      await client.send(
        new PutObjectCommand(tutorialPutObjectInput(bucket, key, body, contentType, cacheControl, immutable)),
      );
    } catch (error: unknown) {
      const status = record(error) && record(error.$metadata) ? error.$metadata.httpStatusCode : undefined;
      if (!immutable || status !== 412) throw error;
      // Another publisher won the create; public-byte verification below still proves that object.
    }
  };
  return {
    putImmutable: (key, body, contentType) => put(key, body, contentType, STATIC_ASSET_CACHE_CONTROL, true),
    putLatest: (key, body) => put(key, body, 'application/json', POINTER_CACHE_CONTROL, false),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }),
  };
}

export async function verifyPublicTutorialAsset(
  asset: Readonly<{ url: string; filename: string; bytes: number; sha256: string; contentType: string; kind: string }>,
  transport: TutorialPublisherTransport,
): Promise<void> {
  const response = await transport.fetch(asset.url);
  if (response.status !== 200) throw new Error(`Tutorial CDN returned ${response.status}: ${asset.filename}`);
  const contentType = response.headers.get('content-type')?.split(';')[0].trim();
  if (contentType !== asset.contentType.split(';')[0].trim())
    throw new Error(`Tutorial CDN MIME differs: ${asset.filename}`);
  const cacheControl = response.headers.get('cache-control') ?? '';
  if (!cacheControl.includes('immutable') || !/max-age=31536000(?:\D|$)/.test(cacheControl))
    throw new Error(`Tutorial CDN immutable caching missing: ${asset.filename}`);
  const bytes = Buffer.from(await readResponseBodyWithinLimit(response, asset.bytes));
  if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256)
    throw new Error(`Tutorial CDN checksum differs: ${asset.filename}`);
  if (asset.kind === 'video') {
    const range = await transport.fetch(asset.url, { headers: { Range: 'bytes=0-1' } });
    if (range.status !== 206 || range.headers.get('content-range') !== `bytes 0-1/${asset.bytes}`)
      throw new Error(`Tutorial CDN video seeking failed: ${asset.filename}`);
    const slice = Buffer.from(await readResponseBodyWithinLimit(range, 2));
    if (!slice.equals(bytes.subarray(0, 2))) throw new Error(`Tutorial CDN video range differs: ${asset.filename}`);
  }
}

/** Verify every immutable object and edition before changing the discoverable latest pointer. */
export async function publishTutorialBundle(
  directory: string,
  options: TutorialPublishOptions = {},
): Promise<TutorialPublicationPlan> {
  const environment = options.environment ?? process.env;
  const plan = await planTutorialPublication(directory, environment);
  if (options.dryRun) return plan;
  const transport = options.transport ?? s3Transport(environment);
  for (const asset of plan.assets) {
    const bytes = await readFile(resolve(directory, asset.filename));
    // Recheck after preflight, guarding edits made during a long upload run.
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256)
      throw new Error(`Tutorial file changed during publishing: ${asset.filename}`);
    await transport.putImmutable(asset.key, bytes, asset.contentType);
    await verifyPublicTutorialAsset(asset, transport);
  }
  await transport.putImmutable(plan.editionKey, plan.editionBytes, 'application/json');
  await verifyPublicTutorialAsset(
    {
      filename: 'edition manifest',
      url: plan.editionUrl,
      bytes: plan.editionBytes.byteLength,
      sha256: plan.editionSha256,
      contentType: 'application/json',
      kind: 'manifest',
    },
    transport,
  );
  await transport.putLatest(plan.latestKey, plan.latestBytes);
  console.info(`[tutorial-publish] Latest: ${plan.latestUrl}`);
  return plan;
}
