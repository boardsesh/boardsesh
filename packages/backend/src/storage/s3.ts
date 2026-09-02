import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ObjectCannedACL,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import { logger } from '../utils/logger';
import {
  BUCKET_ENV_PREFIX,
  describeBucketConfig,
  isBucketConfigured,
  readBucketConfig,
  type BucketConfig,
  type StorageBucket,
} from './bucket-config';

export type { StorageBucket };

// One client and one resolved config per named bucket. Resolution is lazy and
// cached: the config is read from the environment the first time a bucket is
// touched, which is what lets a process that never uploads an avatar run with
// no MEDIA_* variables set at all.
const clients = new Map<StorageBucket, S3Client>();
const configs = new Map<StorageBucket, BucketConfig>();

/**
 * Clear the cached clients and configs.
 *
 * Primarily a test seam — the config is read once per process, so a test that
 * mutates `process.env` needs this to be observed. Also lets an operator apply
 * a corrected variable by restarting the module rather than the process.
 */
export function resetStorageClients(): void {
  clients.clear();
  configs.clear();
}

/**
 * Check whether a bucket is configured. Defaults to `media` so the many call
 * sites that only ever meant "is object storage on?" keep reading naturally.
 */
export function isS3Configured(bucket: StorageBucket = 'media'): boolean {
  return isBucketConfigured(bucket);
}

function getConfig(bucket: StorageBucket): BucketConfig {
  const cached = configs.get(bucket);
  if (cached) return cached;

  const config = readBucketConfig(bucket);
  if (!config) {
    throw new Error(
      `Storage bucket '${bucket}' is not configured. Set ${bucket.toUpperCase()}_S3_BUCKET_NAME with its ` +
        `matching credentials, or the legacy AWS_S3_BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.`,
    );
  }

  configs.set(bucket, config);
  // Logged once per bucket per process. This line is the cheapest guard there
  // is against a typo'd bucket name or a stray public-read ACL: both are
  // otherwise invisible until they 403 or 501 a user's upload.
  logger.info(describeBucketConfig(bucket, config));
  return config;
}

function getS3Client(bucket: StorageBucket): S3Client {
  const cached = clients.get(bucket);
  if (cached) return cached;

  const config = getConfig(bucket);
  const client = new S3Client({
    ...(config.endpointUrl && { endpoint: config.endpointUrl }),
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });

  clients.set(bucket, client);
  return client;
}

/** The configured bucket name for a handle. */
export function getBucketName(bucket: StorageBucket): string {
  return getConfig(bucket).bucketName;
}

/**
 * Browser-reachable URL for a public object.
 *
 * Throws when the bucket has no derivable public form rather than returning a
 * URL that 401s. That is not defensive pedantry — persisting an undereferencable
 * direct-bucket URL is exactly the bug that put legacy
 * `t3.storageapi.dev/<bucket>/...` values into `board_beta_links.thumbnail`,
 * which needed a data backfill to undo. Cloudflare R2 in particular has no
 * unauthenticated URL on its S3 endpoint at all, so `<PREFIX>_PUBLIC_BASE_URL`
 * is the only correct answer there.
 */
export function getPublicUrl(bucket: StorageBucket, key: string): string {
  const config = getConfig(bucket);

  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl}/${key}`;
  }

  // A prefixed bucket must DECLARE its public base; the S3 endpoint is never
  // assumed to be publicly fetchable. R2's requires SigV4 and always 401s, and
  // Tigris only serves public objects on the bucket's virtual-host domain — so
  // deriving one from the endpoint produces a URL that looks right and fails
  // for every anonymous reader.
  if (config.source === 'prefixed') {
    throw new Error(
      `Storage bucket '${bucket}' has no public URL base. Set ${BUCKET_ENV_PREFIX[bucket]}_PUBLIC_BASE_URL — ` +
        `an object-storage S3 endpoint is not publicly fetchable, so there is nothing safe to derive.`,
    );
  }

  if (config.endpointUrl) {
    if (config.forcePathStyle) {
      return `${config.endpointUrl}/${config.bucketName}/${key}`;
    }
    const endpoint = new URL(config.endpointUrl);
    return `${endpoint.protocol}//${config.bucketName}.${endpoint.host}/${key}`;
  }

  return `https://${config.bucketName}.s3.${config.region}.amazonaws.com/${key}`;
}

/**
 * Upload a file.
 *
 * `options.acl` overrides the bucket's default; pass `null` to force no ACL at
 * all. When the resolved ACL is null the `ACL` key is OMITTED from the command
 * input rather than set to undefined — R2 answers `x-amz-acl` with
 * `501 NotImplemented` for every value it doesn't support, so an ACL that
 * merely happens to be undefined is not good enough.
 */
export async function uploadToS3(
  bucket: StorageBucket,
  buffer: Buffer,
  key: string,
  contentType: string,
  options: {
    cacheControl?: string;
    acl?: ObjectCannedACL | null;
    // Sets the object's Content-Encoding (e.g. 'gzip' for a pre-compressed body
    // so a browser/CDN decompresses transparently). Omit for uncompressed bodies.
    contentEncoding?: string;
  } = {},
): Promise<{ key: string }> {
  const client = getS3Client(bucket);
  const config = getConfig(bucket);

  const input: PutObjectCommandInput = {
    Bucket: config.bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: options.cacheControl ?? 'public, max-age=31536000, immutable',
  };

  if (options.contentEncoding) {
    input.ContentEncoding = options.contentEncoding;
  }

  const acl = options.acl === undefined ? config.defaultAcl : options.acl;
  if (acl !== null) {
    input.ACL = acl;
  }

  await client.send(new PutObjectCommand(input));

  return { key };
}

/**
 * Delete a file.
 */
export async function deleteFromS3(bucket: StorageBucket, key: string): Promise<void> {
  const client = getS3Client(bucket);

  await client.send(
    new DeleteObjectCommand({
      Bucket: getConfig(bucket).bucketName,
      Key: key,
    }),
  );
}

/** True for the S3 shapes of "the object does not exist" (vs a read failure). */
function isS3NotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export type S3ObjectBody = {
  stream: Readable;
  contentType: string | undefined;
  contentLength: number | undefined;
};

/**
 * Get a file, distinguishing MISSING from BROKEN: returns null only when the
 * object genuinely does not exist (NoSuchKey / NotFound / 404); any other
 * failure (network, auth, throttling) throws. Use this when acting on "no
 * object" is destructive — e.g. the board-snapshot manifest merge, where
 * treating a transient read error as "no previous manifest" would drop every
 * other board's entries from the published manifest.
 */
export async function getFromS3Strict(bucket: StorageBucket, key: string): Promise<S3ObjectBody | null> {
  const client = getS3Client(bucket);

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: getConfig(bucket).bucketName,
        Key: key,
      }),
    );

    if (!response.Body) {
      return null;
    }

    return {
      stream: response.Body as Readable,
      contentType: response.ContentType,
      contentLength: response.ContentLength,
    };
  } catch (error) {
    if (isS3NotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Get a file and return the stream along with metadata. Lenient variant of
 * getFromS3Strict: returns null for not-found AND for any read error — the
 * existing caller contract (static asset serving, user-data export) treats
 * both as a cache/object miss and falls back.
 */
export async function getFromS3(bucket: StorageBucket, key: string): Promise<S3ObjectBody | null> {
  try {
    return await getFromS3Strict(bucket, key);
  } catch {
    return null;
  }
}

/**
 * Get object metadata without downloading the object body.
 */
export async function getS3ObjectMetadata(
  bucket: StorageBucket,
  key: string,
): Promise<{
  contentType: string | undefined;
  contentLength: number | undefined;
  lastModified: Date | undefined;
} | null> {
  const client = getS3Client(bucket);

  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: getConfig(bucket).bucketName,
        Key: key,
      }),
    );

    return {
      contentType: response.ContentType,
      contentLength: response.ContentLength,
      lastModified: response.LastModified,
    };
  } catch {
    return null;
  }
}

export type S3ObjectSummary = {
  key: string;
  size: number | undefined;
  lastModified: Date | undefined;
};

/**
 * List every object under a key prefix (paginates ListObjectsV2 until done).
 * Errors propagate — callers decide whether a listing failure is fatal.
 */
export async function listS3Objects(bucket: StorageBucket, prefix: string): Promise<S3ObjectSummary[]> {
  const client = getS3Client(bucket);
  const bucketName = getConfig(bucket).bucketName;

  const objects: S3ObjectSummary[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) {
        objects.push({ key: object.Key, size: object.Size, lastModified: object.LastModified });
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

/** Extensions an avatar / gym image can have been stored under. */
const IMAGE_EXTENSIONS = ['jpg', 'png', 'gif', 'webp'] as const;

/**
 * Best-effort delete of every stale-extension object under a media key prefix.
 *
 * S3 DeleteObject is idempotent (deleting a missing key succeeds), so any error
 * here is a real failure (network/auth), not "already gone" — it's logged and
 * swallowed: the replacement is already saved, and a leftover stale-ext object
 * is unreferenced because the stored URL points at the new key.
 */
async function deleteStaleMediaExtensions(prefix: string, id: string, label: string, keepExt?: string): Promise<void> {
  const extensions = IMAGE_EXTENSIONS.filter((ext) => ext !== keepExt);

  await Promise.all(
    extensions.map(async (ext) => {
      const key = `${prefix}/${id}.${ext}`;
      try {
        await deleteFromS3('media', key);
      } catch (deleteError) {
        logger.warn(`Failed to delete stale ${label} ${key} from S3:`, deleteError);
      }
    }),
  );
}

/**
 * Delete a user's avatar files (the key is `avatars/<userId>.<ext>`). Called
 * AFTER a new avatar is written, with `keepExt` set to the new file's
 * extension, so a re-upload at a different extension can't leave a stale file
 * behind — and a failed replacement never destroys the existing avatar
 * (write-first, clean-after; same contract as deleteGymLogosFromS3).
 */
export async function deleteUserAvatarsFromS3(userId: string, keepExt?: string): Promise<void> {
  await deleteStaleMediaExtensions('avatars', userId, 'avatar', keepExt);
}

/**
 * Delete a gym's logo files (the key is `gym-logos/<uuid>.<ext>`). Called AFTER
 * a new logo is written, with `keepExt` set to the new file's extension, so a
 * re-upload at a different extension can't leave a stale file behind — and a
 * failed replacement never destroys the existing logo (write-first, clean-after).
 */
export async function deleteGymLogosFromS3(gymUuid: string, keepExt?: string): Promise<void> {
  await deleteStaleMediaExtensions('gym-logos', gymUuid, 'gym logo', keepExt);
}

/**
 * Delete a gym's photo files (the key is `gym-photos/<uuid>.<ext>`). Same
 * write-first, clean-after contract as deleteGymLogosFromS3.
 *
 * `keepExt` omitted deletes every extension: that's the "owner removed the
 * photo" path, which nulls gyms.image_url first and only then comes here, so a
 * failure leaves an orphaned object (recoverable) rather than a dangling URL.
 */
export async function deleteGymPhotosFromS3(gymUuid: string, keepExt?: string): Promise<void> {
  await deleteStaleMediaExtensions('gym-photos', gymUuid, 'gym photo', keepExt);
}
