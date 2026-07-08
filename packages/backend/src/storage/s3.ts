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

let s3Client: S3Client | null = null;
let bucketName: string | null = null;
let endpointUrl: string | null = null;

/**
 * Check if S3 storage is configured
 */
export function isS3Configured(): boolean {
  return !!(process.env.AWS_S3_BUCKET_NAME && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

/**
 * Get or create the S3 client
 */
function getS3Client(): S3Client {
  if (s3Client) return s3Client;

  const endpoint = process.env.AWS_ENDPOINT_URL;
  const bucket = process.env.AWS_S3_BUCKET_NAME;
  const region = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing required AWS environment variables: AWS_S3_BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY',
    );
  }

  bucketName = bucket;
  endpointUrl = endpoint || null;

  s3Client = new S3Client({
    ...(endpoint && { endpoint }),
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    forcePathStyle: true, // Required for S3-compatible services like Railway
  });

  return s3Client;
}

/**
 * Get the bucket name
 */
export function getBucketName(): string {
  if (!bucketName) {
    getS3Client(); // This will set bucketName
  }
  return bucketName!;
}

/**
 * Get the public URL for an S3 object
 */
export function getPublicUrl(key: string): string {
  const bucket = getBucketName();
  const endpoint = endpointUrl || process.env.AWS_ENDPOINT_URL;

  if (endpoint) {
    // For S3-compatible services (Railway, MinIO, etc.)
    return `${endpoint}/${bucket}/${key}`;
  }

  // For standard AWS S3
  const region = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1';
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Upload a file to S3
 */
export async function uploadToS3(
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
): Promise<{ url: string; key: string }> {
  const client = getS3Client();
  const bucket = getBucketName();

  const input: PutObjectCommandInput = {
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: options.cacheControl ?? 'public, max-age=31536000, immutable',
  };

  if (options.contentEncoding) {
    input.ContentEncoding = options.contentEncoding;
  }

  if (options.acl !== null) {
    input.ACL = options.acl ?? 'public-read';
  }

  await client.send(new PutObjectCommand(input));

  const url = getPublicUrl(key);
  return { url, key };
}

/**
 * Delete a file from S3
 */
export async function deleteFromS3(key: string): Promise<void> {
  const client = getS3Client();
  const bucket = getBucketName();

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
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

/**
 * Get a file from S3, distinguishing MISSING from BROKEN: returns null only
 * when the object genuinely does not exist (NoSuchKey / NotFound / 404); any
 * other failure (network, auth, throttling) throws. Use this when acting on
 * "no object" is destructive — e.g. the board-snapshot manifest merge, where
 * treating a transient read error as "no previous manifest" would drop every
 * other board's entries from the published manifest.
 */
export async function getFromS3Strict(key: string): Promise<{
  stream: Readable;
  contentType: string | undefined;
  contentLength: number | undefined;
} | null> {
  const client = getS3Client();
  const bucket = getBucketName();

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
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
 * Get a file from S3 and return the stream along with metadata. Lenient
 * variant of getFromS3Strict: returns null for not-found AND for any read
 * error — the existing caller contract (static asset serving, user-data
 * export) treats both as a cache/object miss and falls back.
 */
export async function getFromS3(key: string): Promise<{
  stream: Readable;
  contentType: string | undefined;
  contentLength: number | undefined;
} | null> {
  try {
    return await getFromS3Strict(key);
  } catch {
    return null;
  }
}

/**
 * Get S3 object metadata without downloading the object body.
 */
export async function getS3ObjectMetadata(key: string): Promise<{
  contentType: string | undefined;
  contentLength: number | undefined;
  lastModified: Date | undefined;
} | null> {
  const client = getS3Client();
  const bucket = getBucketName();

  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
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
export async function listS3Objects(prefix: string): Promise<S3ObjectSummary[]> {
  const client = getS3Client();
  const bucket = getBucketName();

  const objects: S3ObjectSummary[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
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

/**
 * Delete all avatar files for a user (all extensions)
 */
export async function deleteUserAvatarsFromS3(userId: string): Promise<void> {
  const extensions = ['jpg', 'png', 'gif', 'webp'];

  await Promise.all(
    extensions.map(async (ext) => {
      try {
        await deleteFromS3(`avatars/${userId}.${ext}`);
      } catch {
        // File doesn't exist, ignore
      }
    }),
  );
}
