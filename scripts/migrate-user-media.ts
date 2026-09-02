/// <reference types="node" />

/**
 * One-shot copy of the Railway object-storage bucket into the two Cloudflare R2
 * buckets that replace it.
 *
 * Lives in scripts/ rather than packages/backend because it is an ops tool that
 * must not ship in the backend image, and because it needs TWO credential sets
 * at once — something the backend's bucket registry deliberately does not model.
 *
 *   Source      LEGACY_*   the Railway bucket (Tigris tenant, path-style)
 *   Destination MEDIA_*    boardsesh-user-media   (public via media.boardsesh.com)
 *               PRIVATE_*  boardsesh-user-private (no custom domain ⇒ private)
 *
 * Safe to re-run: the plan skips any destination object that already exists at
 * the same byte size, so a second pass only moves the delta written since the
 * first. That is also how the post-cutover sweep works.
 *
 * Usage:
 *   vp run storage:migrate-user-media -- --dry-run
 *   vp run storage:migrate-user-media
 *   vp run storage:migrate-user-media -- --verify-only
 *   vp run storage:migrate-user-media -- --reverse          # rollback direction
 */

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import {
  classifyKey,
  formatBytes,
  isRetryableStorageError,
  matchesPrefixFilter,
  MIGRATION_ROUTES,
  planMigration,
  verifyMigration,
  type MigrationDestination,
  type ObjectSummary,
} from './lib/object-store-migration';
import { calculatePublicValidationDelay, createRequestStartLimiter } from './lib/static-asset-upload';

/**
 * Objects at or above this size are streamed rather than buffered.
 *
 * Everything in the bucket today is far below it — beta thumbnails are capped
 * at 5 MB by MAX_THUMBNAIL_BYTES and avatars at 2 MB by the upload handler — so
 * in practice every copy takes the buffered path, where the SDK's own retry can
 * replay the body. The streaming branch exists so a future large object degrades
 * to a slower copy instead of an out-of-memory crash.
 */
const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;

const DEFAULT_RATE_PER_SECOND = 50;
const DEFAULT_CONCURRENCY = 8;
const MAX_COPY_ATTEMPTS = 4;
const PROGRESS_EVERY = 250;

type CredentialPrefix = 'LEGACY' | 'MEDIA' | 'PRIVATE';

type BucketClient = Readonly<{ client: S3Client; bucket: string; label: string }>;

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function buildClient(prefix: CredentialPrefix): BucketClient {
  const bucket = requireEnv(`${prefix}_S3_BUCKET_NAME`);
  const endpoint = readEnv(`${prefix}_AWS_ENDPOINT_URL`) ?? readEnv(`${prefix}_AWS_ENDPOINT_URL_S3`);
  const region = readEnv(`${prefix}_AWS_REGION`) ?? readEnv(`${prefix}_AWS_DEFAULT_REGION`) ?? 'auto';
  // The source is the retired Railway bucket, which is path-style — and there
  // is exactly one of it, so defaulting rather than making the operator
  // remember a flag removes a 403 that reads like a credentials problem.
  // R2 destinations are virtual-hosted. Either default is still overridable.
  const forcePathStyle =
    (readEnv(`${prefix}_S3_FORCE_PATH_STYLE`) ?? (prefix === 'LEGACY' ? 'true' : 'false')).toLowerCase() === 'true';

  const client = new S3Client({
    ...(endpoint && { endpoint }),
    region,
    credentials: {
      accessKeyId: requireEnv(`${prefix}_AWS_ACCESS_KEY_ID`),
      secretAccessKey: requireEnv(`${prefix}_AWS_SECRET_ACCESS_KEY`),
    },
    forcePathStyle,
    maxAttempts: 5,
    retryMode: 'adaptive',
  });

  return { client, bucket, label: `${prefix.toLowerCase()}:${bucket}` };
}

type Limiter = () => Promise<void>;

async function listAll(
  target: BucketClient,
  beforeRequest: Limiter,
  prefixes: readonly string[],
): Promise<ObjectSummary[]> {
  const objects: ObjectSummary[] = [];
  // An empty prefix list means "the whole bucket", expressed as one unprefixed
  // listing rather than a special case downstream.
  for (const prefix of prefixes.length > 0 ? prefixes : ['']) {
    let continuationToken: string | undefined;
    do {
      await beforeRequest();
      const response = await target.client.send(
        new ListObjectsV2Command({
          Bucket: target.bucket,
          Prefix: prefix.length > 0 ? prefix : undefined,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key) objects.push({ key: object.Key, size: object.Size ?? 0 });
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  }
  return objects;
}

async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Copy one object, preserving the metadata a CDN cares about.
 *
 * No ACL is ever sent. R2 implements none and answers `x-amz-acl` with
 * `501 NotImplemented`; object visibility there is a property of whether the
 * bucket has a custom domain attached.
 */
async function copyObject(
  source: BucketClient,
  destination: BucketClient,
  key: string,
  beforeSourceRequest: Limiter,
  beforeDestinationRequest: Limiter,
): Promise<number> {
  let lastError: unknown;
  // Held so a failed attempt can destroy a stream it never consumed; a
  // buffered body has already drained the socket by the time the PUT runs.
  let unconsumedSourceStream: Readable | null = null;

  for (let attempt = 1; attempt <= MAX_COPY_ATTEMPTS; attempt += 1) {
    try {
      await beforeSourceRequest();
      const object: GetObjectCommandOutput = await source.client.send(
        new GetObjectCommand({ Bucket: source.bucket, Key: key }),
      );
      if (!object.Body) throw new Error(`Source object has no body: ${key}`);

      // ContentLength from the GetObject response is authoritative at read
      // time; the listing's size may be stale if the object was rewritten.
      const contentLength = object.ContentLength ?? 0;
      const shouldStream = contentLength >= STREAM_THRESHOLD_BYTES;
      const body = shouldStream ? (object.Body as Readable) : await collectStream(object.Body as Readable);
      const bytes = shouldStream ? contentLength : (body as Buffer).length;
      unconsumedSourceStream = shouldStream ? (object.Body as Readable) : null;

      await beforeDestinationRequest();
      await destination.client.send(
        new PutObjectCommand({
          Bucket: destination.bucket,
          Key: key,
          Body: body,
          ...(shouldStream && { ContentLength: contentLength }),
          ...(object.ContentType && { ContentType: object.ContentType }),
          ...(object.CacheControl && { CacheControl: object.CacheControl }),
          ...(object.ContentEncoding && { ContentEncoding: object.ContentEncoding }),
          ...(object.ContentDisposition && { ContentDisposition: object.ContentDisposition }),
        }),
      );

      unconsumedSourceStream = null;
      return bytes;
    } catch (error) {
      lastError = error;
      // A consumed stream cannot be replayed, so every retry re-issues the GET
      // from the top of this loop rather than reusing the previous body. Close
      // the one this attempt opened first, or its socket stays held until GC.
      unconsumedSourceStream?.destroy();
      unconsumedSourceStream = null;
      if (attempt === MAX_COPY_ATTEMPTS || !isRetryableStorageError(error)) break;
      await sleep(calculatePublicValidationDelay(attempt));
    }
  }

  throw new Error(
    `Failed to copy ${key} after ${MAX_COPY_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function withConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

type Options = Readonly<{
  dryRun: boolean;
  verifyOnly: boolean;
  reverse: boolean;
  rate: number;
  concurrency: number;
  prefixFilters: readonly string[];
  onlyDestination: MigrationDestination | null;
}>;

function parseOptions(argv: readonly string[]): Options {
  const prefixFilters: string[] = [];
  let onlyDestination: MigrationDestination | null = null;
  let rate = DEFAULT_RATE_PER_SECOND;
  let concurrency = DEFAULT_CONCURRENCY;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const readValue = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };
    switch (argument) {
      case '--dry-run':
      case '--verify-only':
      case '--reverse':
        break;
      case '--prefix':
        prefixFilters.push(readValue());
        break;
      case '--only': {
        const value = readValue();
        if (value !== 'media' && value !== 'private') throw new Error(`--only must be 'media' or 'private'`);
        onlyDestination = value;
        break;
      }
      case '--rate':
        rate = Number(readValue());
        if (!Number.isFinite(rate) || rate <= 0) throw new Error('--rate must be a positive number');
        break;
      case '--concurrency':
        concurrency = Number(readValue());
        if (!Number.isInteger(concurrency) || concurrency <= 0)
          throw new Error('--concurrency must be a positive integer');
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return {
    dryRun: argv.includes('--dry-run'),
    verifyOnly: argv.includes('--verify-only'),
    reverse: argv.includes('--reverse'),
    rate,
    concurrency,
    prefixFilters,
    onlyDestination,
  };
}

/** Prefixes to list at a destination, so a scoped run doesn't page the whole bucket. */
function destinationPrefixes(destination: MigrationDestination, filters: readonly string[]): string[] {
  const routed = MIGRATION_ROUTES.filter((route) => route.destination === destination).map((route) => route.prefix);
  if (filters.length === 0) return routed;
  // Keep any route the filter touches, in either direction, so a filter that is
  // narrower than a route ("avatars/ab") and one that is broader both work.
  return routed.filter((prefix) => filters.some((filter) => prefix.startsWith(filter) || filter.startsWith(prefix)));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const legacy = buildClient('LEGACY');
  const media = buildClient('MEDIA');
  const priv = buildClient('PRIVATE');

  // --reverse swaps which side is read and which is written, so the rollback
  // path is the same code rather than a second script that can rot.
  const destinations: Record<MigrationDestination, BucketClient> = { media, private: priv };

  const sourceLimiter = createRequestStartLimiter(options.rate);
  const destinationLimiter = createRequestStartLimiter(options.rate);

  const startedAt = Date.now();
  console.log(
    `Migration: ${options.reverse ? 'R2 → legacy (REVERSE)' : `${legacy.label} → media/private`}` +
      `  rate=${options.rate}/s per side concurrency=${options.concurrency}` +
      (options.prefixFilters.length > 0 ? ` prefixes=${options.prefixFilters.join(',')}` : '') +
      (options.onlyDestination ? ` only=${options.onlyDestination}` : ''),
  );

  if (options.reverse) {
    await runReverse(legacy, destinations, options, sourceLimiter, destinationLimiter);
    return;
  }

  // With --only, list just the routes that feed that destination rather than
  // paging the whole bucket and discarding most of it. Explicit --prefix
  // filters win, since they are already narrower than a route.
  const sourcePrefixes =
    options.prefixFilters.length > 0
      ? options.prefixFilters
      : options.onlyDestination
        ? MIGRATION_ROUTES.filter((route) => route.destination === options.onlyDestination).map((r) => r.prefix)
        : [];
  console.log(`Listing ${legacy.label} …`);
  const sourceObjects = await listAll(legacy, sourceLimiter, sourcePrefixes);
  console.log(`  ${sourceObjects.length} objects`);

  const destinationObjects: Record<MigrationDestination, ObjectSummary[]> = { media: [], private: [] };
  for (const destination of ['media', 'private'] as const) {
    if (options.onlyDestination && destination !== options.onlyDestination) continue;
    const prefixes = destinationPrefixes(destination, options.prefixFilters);
    if (prefixes.length === 0) continue;
    console.log(`Listing ${destinations[destination].label} …`);
    destinationObjects[destination] = await listAll(destinations[destination], destinationLimiter, prefixes);
    console.log(`  ${destinationObjects[destination].length} objects`);
  }

  if (options.verifyOnly) {
    reportVerification(verifyMigration(sourceObjects, destinationObjects, options));
    return;
  }

  const plan = planMigration(sourceObjects, destinationObjects, options);

  if (plan.unroutable.length > 0) {
    // Fail before a single byte moves. An unrecognised prefix might be private
    // data, and the media bucket becomes world-readable in PR 2.
    console.error(`\nABORTING: ${plan.unroutable.length} key(s) match no route in MIGRATION_ROUTES:`);
    for (const key of plan.unroutable.slice(0, 20)) console.error(`  ${key}`);
    if (plan.unroutable.length > 20) console.error(`  … and ${plan.unroutable.length - 20} more`);
    console.error('\nAdd a route in scripts/lib/object-store-migration.ts, then re-run.');
    process.exit(1);
  }

  console.log('\nPlan:');
  for (const summary of plan.byPrefix) {
    console.log(
      `  ${summary.prefix.padEnd(28)} → ${summary.destination.padEnd(7)} ` +
        `${String(summary.objects).padStart(6)} objects ${formatBytes(summary.bytes).padStart(10)} · ` +
        `copy ${summary.toCopy} (${formatBytes(summary.bytesToCopy)})`,
    );
  }
  const totalBytes = plan.copies.reduce((sum, copy) => sum + copy.size, 0);
  console.log(`  ${plan.copies.length} to copy (${formatBytes(totalBytes)}), ${plan.skipped} already present`);
  if (plan.emptySourceKeys.length > 0) {
    console.log(`  note: ${plan.emptySourceKeys.length} zero-byte source object(s) — copied as-is`);
  }

  if (options.dryRun) {
    console.log('\nDry run: nothing copied.');
    return;
  }
  if (plan.copies.length === 0) {
    console.log('\nNothing to copy.');
    return;
  }

  let copied = 0;
  let copiedBytes = 0;
  await withConcurrency(plan.copies, options.concurrency, async (copy) => {
    const bytes = await copyObject(legacy, destinations[copy.destination], copy.key, sourceLimiter, destinationLimiter);
    copied += 1;
    copiedBytes += bytes;
    if (copied % PROGRESS_EVERY === 0 || copied === plan.copies.length) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const rate = copied / Math.max(elapsedSeconds, 0.001);
      const remaining = plan.copies.length - copied;
      console.log(
        `  [${copied}/${plan.copies.length}] ${formatBytes(copiedBytes)} · ${rate.toFixed(1)}/s · ` +
          `ETA ${Math.round(remaining / Math.max(rate, 0.001))}s`,
      );
    }
  });

  console.log(`\nCopied ${copied} objects (${formatBytes(copiedBytes)}). Verifying …`);
  const afterObjects: Record<MigrationDestination, ObjectSummary[]> = { media: [], private: [] };
  for (const destination of ['media', 'private'] as const) {
    if (options.onlyDestination && destination !== options.onlyDestination) continue;
    const prefixes = destinationPrefixes(destination, options.prefixFilters);
    if (prefixes.length === 0) continue;
    afterObjects[destination] = await listAll(destinations[destination], destinationLimiter, prefixes);
  }
  const verification = verifyMigration(sourceObjects, afterObjects, options);
  reportVerification(verification, { copied, copiedBytes, durationMs: Date.now() - startedAt, plan: plan.byPrefix });
  if (verification.problems.length > 0) process.exit(1);
}

/**
 * Rollback: copy R2 objects back into the legacy bucket.
 *
 * `--dry-run` and `--verify-only` both make this read-only; the difference is
 * that `--verify-only` exits non-zero when anything is missing, so it can gate
 * a script.
 */
async function runReverse(
  legacy: BucketClient,
  destinations: Record<MigrationDestination, BucketClient>,
  options: Options,
  legacyLimiter: Limiter,
  r2Limiter: Limiter,
): Promise<void> {
  const readOnly = options.dryRun || options.verifyOnly;
  const legacyObjects = await listAll(legacy, legacyLimiter, options.prefixFilters);
  const legacySizes = new Map(legacyObjects.map((object) => [object.key, object.size]));
  let outstanding = 0;

  for (const destination of ['media', 'private'] as const) {
    if (options.onlyDestination && destination !== options.onlyDestination) continue;
    const prefixes = destinationPrefixes(destination, options.prefixFilters);
    if (prefixes.length === 0) continue;

    // `destinationPrefixes` widens a narrow filter up to whole routes so the
    // listing is a valid S3 prefix, which means it can return keys the filter
    // does not actually cover (`--prefix beta-link-thumbnails/instagram/`
    // lists tiktok too). Re-apply the filter here, or those keys look absent
    // from the prefix-scoped legacy listing and get "restored" spuriously.
    const listed = await listAll(destinations[destination], r2Limiter, prefixes);
    const objects = listed.filter((object) => matchesPrefixFilter(object.key, options.prefixFilters));
    if (objects.length !== listed.length) {
      console.log(
        `  ${destination}: listed ${prefixes.join(', ')} (${listed.length} objects) because an S3 prefix cannot be ` +
          `narrower than a route; ${listed.length - objects.length} outside --prefix ignored`,
      );
    }
    const missing = objects.filter((object) => legacySizes.get(object.key) !== object.size);
    outstanding += missing.length;
    console.log(`  ${destination}: ${missing.length} object(s) to restore of ${objects.length}`);
    if (readOnly || missing.length === 0) continue;

    await withConcurrency(missing, options.concurrency, async (object) => {
      await copyObject(destinations[destination], legacy, object.key, r2Limiter, legacyLimiter);
    });
  }

  if (options.verifyOnly) {
    console.log(`\nVerification (reverse): ${outstanding} object(s) not yet back in ${legacy.label}.`);
    console.log(`\nSUMMARY ${JSON.stringify({ direction: 'reverse', outstanding })}`);
    if (outstanding > 0) process.exit(1);
    return;
  }
  console.log(options.dryRun ? '\nDry run: nothing restored.' : '\nRestore complete.');
}

function reportVerification(
  verification: ReturnType<typeof verifyMigration>,
  extra?: { copied: number; copiedBytes: number; durationMs: number; plan: unknown },
): void {
  const missing = verification.problems.filter((problem) => problem.kind === 'missing');
  const mismatched = verification.problems.filter((problem) => problem.kind === 'size-mismatch');

  console.log(
    `Verification: ${verification.checked} checked, ${missing.length} missing, ${mismatched.length} size mismatch`,
  );
  for (const problem of verification.problems.slice(0, 20)) {
    console.error(
      `  ${problem.kind}: ${problem.destination}/${problem.key} ` +
        `(source ${problem.sourceSize}, destination ${problem.destinationSize ?? 'absent'})`,
    );
  }
  if (verification.problems.length > 20) {
    console.error(`  … and ${verification.problems.length - 20} more`);
  }

  // A machine-readable line to paste into the PR.
  console.log(
    `\nSUMMARY ${JSON.stringify({
      checked: verification.checked,
      missing: missing.length,
      sizeMismatches: mismatched.length,
      unroutable: verification.unroutable.length,
      ...(extra && {
        copied: extra.copied,
        copiedBytes: extra.copiedBytes,
        durationSeconds: Math.round(extra.durationMs / 1000),
        byPrefix: extra.plan,
      }),
    })}`,
  );
}

// Re-exported so a caller (and the tests) can reach the routing table without
// importing the pure module separately.
export { classifyKey, MIGRATION_ROUTES };

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
