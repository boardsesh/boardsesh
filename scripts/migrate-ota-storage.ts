/// <reference types="node" />

/**
 * Copy the live XPRem V3 bucket from Tigris to its private Cloudflare R2 bucket.
 *
 * Source credentials are read from the production Railway service at runtime.
 * Destination credentials come from OTA_R2_* environment variables. This tool
 * never mutates Railway and imports no S3 delete operation.
 *
 * Usage:
 *   vp run storage:migrate-ota                 # inventory only
 *   vp run storage:migrate-ota -- --apply      # idempotent copy, then verify
 *   vp run storage:migrate-ota -- --verify-only
 */

import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { OTA_SERVICE_NAME, RAILWAY_ENVIRONMENT_NAME } from '../infra/railway/config';
import {
  assertCopyPreflight,
  classifyStorageEndpoint,
  diffInventories,
  expectedDestinationMetadata,
  fingerprintsMatch,
  metadataMatches,
  verifyObjectStores,
  type ObjectFingerprint,
  type ObjectInventoryEntry,
  type ObjectMetadata,
} from './lib/ota-storage-migration';

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';
const RAILWAY_TIMEOUT_MS = 30_000;
const OTA_BUCKET_NAME = 'boardsesh-ota-v3';
const MAX_REPORTED_PROBLEMS = 20;
const COPY_CONCURRENCY = 4;

type MigrationMode = 'inventory' | 'copy' | 'verify';
type AuthScheme = 'project' | 'account';
type BucketClient = Readonly<{ client: S3Client; bucket: string; label: 'source' | 'destination' }>;

interface GraphQLResponse<TData> {
  data?: TData;
  errors?: { message: string }[];
}

interface RailwayProjectResponse {
  project: {
    environments: { edges: { node: { id: string; name: string } }[] };
    services: { edges: { node: { id: string; name: string } }[] };
  };
}

const PROJECT_QUERY = `
  query OtaStorageMigrationProject($projectId: String!) {
    project(id: $projectId) {
      environments { edges { node { id name } } }
      services { edges { node { id name } } }
    }
  }
`;

const VARIABLES_QUERY = `
  query OtaStorageMigrationVariables($projectId: String!, $environmentId: String!, $serviceId: String!) {
    variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
  }
`;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function authHeaders(scheme: AuthScheme, token: string): Record<string, string> {
  return scheme === 'project' ? { 'Project-Access-Token': token } : { Authorization: `Bearer ${token}` };
}

function parseEnvelope<TData>(rawBody: string): GraphQLResponse<TData> | null {
  try {
    return rawBody ? (JSON.parse(rawBody) as GraphQLResponse<TData>) : null;
  } catch {
    return null;
  }
}

function isAuthorizationFailure<TData>(response: Response, envelope: GraphQLResponse<TData> | null): boolean {
  return (
    response.status === 401 ||
    response.status === 403 ||
    envelope?.errors?.some(({ message }) => /^Not Authorized\.?$/i.test(message.trim())) === true
  );
}

async function postRailway(token: string, scheme: AuthScheme, body: string): Promise<Response> {
  return fetch(RAILWAY_API, {
    method: 'POST',
    headers: { ...authHeaders(scheme, token), 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(RAILWAY_TIMEOUT_MS),
  });
}

async function railwayRequest<TData>(token: string, query: string, variables: Record<string, unknown>): Promise<TData> {
  const requestBody = JSON.stringify({ query, variables });
  let response = await postRailway(token, 'project', requestBody);
  let rawBody = await response.text();
  let envelope = parseEnvelope<TData>(rawBody);

  if (isAuthorizationFailure(response, envelope)) {
    response = await postRailway(token, 'account', requestBody);
    rawBody = await response.text();
    envelope = parseEnvelope<TData>(rawBody);
  }

  if (!response.ok || !envelope || envelope.errors?.length) {
    const messages = envelope?.errors?.map(({ message }) => message).join('; ');
    throw new Error(`Railway API request failed (HTTP ${response.status})${messages ? `: ${messages}` : ''}.`);
  }
  if (!envelope.data) throw new Error('Railway API returned no data.');
  return envelope.data;
}

/** Read exactly one service's variables. No Railway mutation exists in this module. */
export async function fetchRailwayServiceVariables(
  token: string,
  projectId: string,
  environmentName: string,
  serviceName: string,
): Promise<Record<string, string>> {
  const project = await railwayRequest<RailwayProjectResponse>(token, PROJECT_QUERY, { projectId });
  const environment = project.project.environments.edges.find(({ node }) => node.name === environmentName)?.node;
  const service = project.project.services.edges.find(({ node }) => node.name === serviceName)?.node;
  if (!environment) throw new Error(`Railway environment not found: ${environmentName}`);
  if (!service) throw new Error(`Railway service not found: ${serviceName}`);

  const result = await railwayRequest<{ variables: Record<string, string> }>(token, VARIABLES_QUERY, {
    projectId,
    environmentId: environment.id,
    serviceId: service.id,
  });
  return result.variables ?? {};
}

function requireRailwayVariable(variables: Record<string, string>, name: string): string {
  const value = variables[name]?.trim();
  if (!value) throw new Error(`The Railway OTA service is missing required variable ${name}.`);
  return value;
}

function maskForGitHubActions(value: string): void {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${value}`);
}

function parseMode(argv: readonly string[]): MigrationMode {
  const apply = argv.includes('--apply');
  const verify = argv.includes('--verify-only');
  const unknown = argv.filter((argument) => argument !== '--apply' && argument !== '--verify-only');
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  if (apply && verify) throw new Error('--apply and --verify-only are mutually exclusive.');
  return apply ? 'copy' : verify ? 'verify' : 'inventory';
}

function createBucketClient(
  label: BucketClient['label'],
  endpoint: string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
  forcePathStyle: boolean,
): BucketClient {
  return {
    label,
    bucket: OTA_BUCKET_NAME,
    client: new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle,
      maxAttempts: 5,
      retryMode: 'adaptive',
    }),
  };
}

export async function listAllObjects(target: BucketClient): Promise<ObjectInventoryEntry[]> {
  const objects: ObjectInventoryEntry[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await target.client.send(
      new ListObjectsV2Command({ Bucket: target.bucket, ContinuationToken: continuationToken }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) objects.push({ key: object.Key, size: object.Size ?? 0 });
    }
    if (response.IsTruncated && !response.NextContinuationToken) {
      throw new Error(`${target.label} listing was truncated without a continuation token.`);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  objects.sort((left, right) => left.key.localeCompare(right.key));
  return objects;
}

function normalizeMetadata(
  response: GetObjectCommandOutput,
  key: string,
  label: BucketClient['label'],
): ObjectMetadata {
  if ((response.MissingMeta ?? 0) > 0) {
    throw new Error(`${label} metadata was omitted by the S3 API and cannot be verified: ${key}`);
  }
  if (
    response.WebsiteRedirectLocation ||
    response.ObjectLockMode ||
    response.ObjectLockRetainUntilDate ||
    response.ObjectLockLegalHoldStatus
  ) {
    throw new Error(`${label} object uses metadata Cloudflare R2 cannot preserve: ${key}`);
  }
  return {
    contentType: response.ContentType ?? null,
    cacheControl: response.CacheControl ?? null,
    contentDisposition: response.ContentDisposition ?? null,
    contentEncoding: response.ContentEncoding ?? null,
    contentLanguage: response.ContentLanguage ?? null,
    expires: response.Expires?.toISOString() ?? null,
    userMetadata: Object.fromEntries(
      Object.entries(response.Metadata ?? {}).map(([key, value]) => [key.toLowerCase(), value ?? '']),
    ),
  };
}

function readableBody(response: GetObjectCommandOutput, key: string): Readable {
  if (!response.Body) throw new Error(`Object has no body: ${key}`);
  return response.Body as Readable;
}

async function fingerprintObject(target: BucketClient, key: string): Promise<ObjectFingerprint> {
  if (target.label === 'source') await assertSourceHasNoTags(target, key);
  const response = await target.client.send(new GetObjectCommand({ Bucket: target.bucket, Key: key }));
  const hash = createHash('sha256');
  let size = 0;
  for await (const rawChunk of readableBody(response, key)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as ArrayBuffer);
    hash.update(chunk);
    size += chunk.length;
  }
  if (response.ContentLength !== undefined && response.ContentLength !== size) {
    throw new Error(`${target.label} object changed or truncated while reading: ${key}`);
  }
  return { size, sha256: hash.digest('hex'), metadata: normalizeMetadata(response, key, target.label) };
}

async function assertSourceHasNoTags(source: BucketClient, key: string): Promise<void> {
  const response = await source.client.send(new GetObjectTaggingCommand({ Bucket: source.bucket, Key: key }));
  if ((response.TagSet?.length ?? 0) > 0) {
    throw new Error(`Source object has S3 tags Cloudflare R2 cannot preserve: ${key}`);
  }
}

type TemporarySource = Readonly<{ path: string; contentMd5: string; fingerprint: ObjectFingerprint }>;

async function downloadSourceToFile(source: BucketClient, key: string, directory: string): Promise<TemporarySource> {
  await assertSourceHasNoTags(source, key);
  const response = await source.client.send(new GetObjectCommand({ Bucket: source.bucket, Key: key }));
  const path = join(directory, randomUUID());
  const hash = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;
  const meter = new Transform({
    transform(rawChunk: Buffer, _encoding, callback) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      hash.update(chunk);
      md5.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(readableBody(response, key), meter, createWriteStream(path, { flags: 'wx' }));
  const file = await stat(path);
  if (file.size !== size || (response.ContentLength !== undefined && response.ContentLength !== size)) {
    throw new Error(`Source object changed or truncated while staging: ${key}`);
  }
  return {
    path,
    contentMd5: md5.digest('base64'),
    fingerprint: { size, sha256: hash.digest('hex'), metadata: normalizeMetadata(response, key, source.label) },
  };
}

async function putDestination(destination: BucketClient, key: string, source: TemporarySource): Promise<void> {
  const metadata = expectedDestinationMetadata(source.fingerprint);
  await destination.client.send(
    new PutObjectCommand({
      Bucket: destination.bucket,
      Key: key,
      Body: createReadStream(source.path),
      ContentLength: source.fingerprint.size,
      ContentMD5: source.contentMd5,
      ...(metadata.contentType && { ContentType: metadata.contentType }),
      ...(metadata.cacheControl && { CacheControl: metadata.cacheControl }),
      ...(metadata.contentDisposition && { ContentDisposition: metadata.contentDisposition }),
      ...(metadata.contentEncoding && { ContentEncoding: metadata.contentEncoding }),
      ...(metadata.contentLanguage && { ContentLanguage: metadata.contentLanguage }),
      ...(metadata.expires && { Expires: new Date(metadata.expires) }),
      Metadata: { ...metadata.userMetadata },
    }),
  );
}

export function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'NoSuchKey' || candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404;
}

async function copyAll(
  source: BucketClient,
  destination: BucketClient,
  sourceInventory: readonly ObjectInventoryEntry[],
  destinationInventory: readonly ObjectInventoryEntry[],
): Promise<{ copied: number; skipped: number }> {
  assertCopyPreflight(sourceInventory, destinationInventory);
  const destinationSizes = new Map(destinationInventory.map(({ key, size }) => [key, size]));
  const directory = await mkdtemp(join(tmpdir(), 'boardsesh-ota-r2-'));
  let copied = 0;
  let skipped = 0;
  let completed = 0;
  let nextIndex = 0;
  let stopped = false;
  let firstError: unknown;
  try {
    const workers = Array.from({ length: Math.min(COPY_CONCURRENCY, sourceInventory.length) }, async () => {
      while (!stopped && nextIndex < sourceInventory.length) {
        const object = sourceInventory[nextIndex];
        nextIndex += 1;
        try {
          const staged = await downloadSourceToFile(source, object.key, directory);
          try {
            if (stopped) continue;
            let alreadyMatches = false;
            if (destinationSizes.get(object.key) === staged.fingerprint.size) {
              try {
                const destinationFingerprint = await fingerprintObject(destination, object.key);
                alreadyMatches =
                  destinationFingerprint.sha256 === staged.fingerprint.sha256 &&
                  metadataMatches(expectedDestinationMetadata(staged.fingerprint), destinationFingerprint.metadata);
              } catch (error) {
                // Only a real not-found race becomes a recopy. Auth, transport and
                // provider failures must stop before they turn into blind writes.
                if (!isNotFoundError(error)) throw error;
              }
            }

            if (alreadyMatches) skipped += 1;
            else {
              await putDestination(destination, object.key, staged);
              copied += 1;
            }
          } finally {
            await rm(staged.path, { force: true });
          }
          completed += 1;
          if (completed % 100 === 0 || completed === sourceInventory.length) {
            console.log(
              `Processed ${completed}/${sourceInventory.length} objects (${copied} copied, ${skipped} unchanged).`,
            );
          }
        } catch (error) {
          stopped = true;
          firstError ??= error;
        }
      }
    });
    await Promise.all(workers);
    if (firstError) throw firstError;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { copied, skipped };
}

function inventoryBytes(objects: readonly ObjectInventoryEntry[]): number {
  return objects.reduce((total, object) => total + object.size, 0);
}

async function loadFingerprintMap(
  target: BucketClient,
  inventory: readonly ObjectInventoryEntry[],
): Promise<Map<string, ObjectFingerprint>> {
  const fingerprints = new Map<string, ObjectFingerprint>();
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(COPY_CONCURRENCY, inventory.length) }, async () => {
    while (nextIndex < inventory.length) {
      const key = inventory[nextIndex].key;
      nextIndex += 1;
      fingerprints.set(key, await fingerprintObject(target, key));
    }
  });
  await Promise.all(workers);
  return fingerprints;
}

function reportInventory(source: readonly ObjectInventoryEntry[], destination: readonly ObjectInventoryEntry[]): void {
  const difference = diffInventories(source, destination);
  console.log(`Source inventory: ${source.length} objects, ${inventoryBytes(source)} bytes.`);
  console.log(`Destination inventory: ${destination.length} objects, ${inventoryBytes(destination)} bytes.`);
  console.log(
    `Inventory differences: ${difference.missing.length} missing, ${difference.extra.length} extra, ` +
      `${difference.sizeMismatches.length} size mismatches.`,
  );
}

async function verify(source: BucketClient, destination: BucketClient): Promise<void> {
  const [sourceInventory, destinationInventory] = await Promise.all([
    listAllObjects(source),
    listAllObjects(destination),
  ]);
  reportInventory(sourceInventory, destinationInventory);
  const sourceFingerprints = await loadFingerprintMap(source, sourceInventory);
  const problems = [
    ...(await verifyObjectStores(sourceInventory, destinationInventory, (side, key) => {
      if (side === 'destination') return fingerprintObject(destination, key);
      const fingerprint = sourceFingerprints.get(key);
      if (!fingerprint) throw new Error(`Source fingerprint missing unexpectedly: ${key}`);
      return Promise.resolve(fingerprint);
    })),
  ];
  const sourceAfterVerification = await listAllObjects(source);
  const sourceChanged = diffInventories(sourceInventory, sourceAfterVerification);
  if (sourceChanged.missing.length > 0 || sourceChanged.extra.length > 0 || sourceChanged.sizeMismatches.length > 0) {
    throw new Error('Tigris inventory changed during verification. Keep OTA publishing frozen and run again.');
  }
  const sourceFingerprintsAfter = await loadFingerprintMap(source, sourceAfterVerification);
  for (const [key, before] of sourceFingerprints) {
    const after = sourceFingerprintsAfter.get(key);
    if (!after || !fingerprintsMatch(before, after)) {
      problems.push({ key, kind: 'content', detail: 'Tigris object changed during verification' });
    }
  }
  if (problems.length > 0) {
    console.error(`Verification failed with ${problems.length} problem(s):`);
    for (const problem of problems.slice(0, MAX_REPORTED_PROBLEMS)) {
      console.error(`  ${problem.kind}: ${problem.key} (${problem.detail})`);
    }
    if (problems.length > MAX_REPORTED_PROBLEMS) {
      console.error(`  … and ${problems.length - MAX_REPORTED_PROBLEMS} more`);
    }
    throw new Error('OTA storage migration verification failed; Railway remains unchanged.');
  }
  console.log(`Verified ${sourceInventory.length} objects by exact key set, size, SHA-256, and metadata.`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const mode = parseMode(argv);
  const railwayVariables = await fetchRailwayServiceVariables(
    requireEnv('RAILWAY_TOKEN'),
    requireEnv('RAILWAY_PROJECT_ID'),
    RAILWAY_ENVIRONMENT_NAME,
    OTA_SERVICE_NAME,
  );

  const sourceEndpoint = requireRailwayVariable(railwayVariables, 'AWS_BASE_ENDPOINT');
  const sourceAccessKeyId = requireRailwayVariable(railwayVariables, 'AWS_ACCESS_KEY_ID');
  const sourceSecretAccessKey = requireRailwayVariable(railwayVariables, 'AWS_SECRET_ACCESS_KEY');
  maskForGitHubActions(sourceAccessKeyId);
  maskForGitHubActions(sourceSecretAccessKey);
  const sourceProvider = classifyStorageEndpoint(sourceEndpoint);
  console.log(`Live Railway OTA storage provider: ${sourceProvider}.`);
  if (sourceProvider === 'r2') {
    throw new Error('Railway already points at R2; refusing a Tigris-to-R2 copy with no Tigris source.');
  }
  if (sourceProvider !== 'tigris') {
    throw new Error('The live Railway OTA endpoint is not a recognized Tigris endpoint; refusing to guess.');
  }
  if (requireRailwayVariable(railwayVariables, 'S3_BUCKET_NAME') !== OTA_BUCKET_NAME) {
    throw new Error(`The Railway OTA service does not use the expected bucket ${OTA_BUCKET_NAME}.`);
  }
  if (requireRailwayVariable(railwayVariables, 'STORAGE_MODE').toLowerCase() !== 's3') {
    throw new Error('The Railway OTA service is not configured for S3 storage.');
  }

  const destinationEndpoint = requireEnv('OTA_R2_AWS_ENDPOINT_URL');
  let destinationUrl: URL;
  try {
    destinationUrl = new URL(destinationEndpoint);
  } catch {
    throw new Error('OTA_R2_AWS_ENDPOINT_URL must be an HTTPS Cloudflare R2 account endpoint.');
  }
  if (
    classifyStorageEndpoint(destinationEndpoint) !== 'r2' ||
    destinationUrl.port ||
    destinationUrl.pathname !== '/' ||
    destinationUrl.search ||
    destinationUrl.hash
  ) {
    throw new Error('OTA_R2_AWS_ENDPOINT_URL must be an HTTPS Cloudflare R2 account endpoint.');
  }

  const source = createBucketClient(
    'source',
    sourceEndpoint,
    railwayVariables.AWS_REGION?.trim() || 'auto',
    sourceAccessKeyId,
    sourceSecretAccessKey,
    railwayVariables.AWS_S3_FORCE_PATH_STYLE?.trim().toLowerCase() === 'true',
  );
  const destination = createBucketClient(
    'destination',
    destinationEndpoint,
    readEnv('OTA_R2_AWS_REGION') ?? 'auto',
    requireEnv('OTA_R2_AWS_ACCESS_KEY_ID'),
    requireEnv('OTA_R2_AWS_SECRET_ACCESS_KEY'),
    false,
  );

  if (mode === 'verify') {
    await verify(source, destination);
    return;
  }

  const [sourceInventory, destinationInventory] = await Promise.all([
    listAllObjects(source),
    listAllObjects(destination),
  ]);
  reportInventory(sourceInventory, destinationInventory);
  if (mode === 'inventory') {
    console.log('Inventory only: no objects copied and Railway was not changed.');
    return;
  }

  const result = await copyAll(source, destination, sourceInventory, destinationInventory);
  console.log(
    `Copy complete: ${result.copied} copied, ${result.skipped} already identical. Verifying from providers …`,
  );
  await verify(source, destination);
  console.log('R2 copy verified. Railway still points at Tigris; credential rotation is a separate manual cutover.');
}

if (process.argv[1]?.endsWith('migrate-ota-storage.ts')) {
  main().catch((error: unknown) => {
    console.error(`[migrate-ota-storage] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
