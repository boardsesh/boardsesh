import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { migrateStaticAssets, parseMigrationMode, type AssetStore } from './lib/static-asset-migration';
import { createRequestStartLimiter } from './lib/static-asset-upload';

function requiredEnvironment(name: string): string {
  const configured = process.env[name]?.trim();
  if (!configured) throw new Error(`Missing required environment variable: ${name}`);
  return configured;
}

/** AWS request completion can remove its abort listener before the body finishes. */
export function boundedAssetBody(body: Readable, key: string, timeoutMilliseconds = 60_000): AsyncIterable<Uint8Array> {
  const deadlineAt = Date.now() + timeoutMilliseconds;
  return (async function* () {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const remainingMilliseconds = deadlineAt - Date.now();
      if (remainingMilliseconds <= 0) throw new Error(`Asset body read timed out: ${key}`);
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Asset body read timed out: ${key}`)), remainingMilliseconds);
      });
      const iterator = body[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
      while (!body.destroyed) {
        const chunk = await Promise.race([iterator.next(), deadline]);
        if (chunk.done) return;
        if (!(chunk.value instanceof Uint8Array)) throw new Error(`Asset body is not binary: ${key}`);
        yield chunk.value;
      }
    } finally {
      clearTimeout(timeout);
      body.destroy();
    }
  })();
}

export function createAssetStore(client: S3Client, bucket: string): AssetStore {
  const beforeRequest = createRequestStartLimiter(5);
  const requestOptions = () => ({ abortSignal: AbortSignal.timeout(60_000) });
  return {
    async list(token) {
      await beforeRequest();
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: 'static/v1/',
          ContinuationToken: token,
        }),
        requestOptions(),
      );
      return {
        keys: (response.Contents ?? []).map((object) => {
          if (!object.Key) throw new Error('Asset listing contains an object without a key');
          return object.Key;
        }),
        truncated: response.IsTruncated === true,
        nextToken: response.NextContinuationToken,
      };
    },
    async get(key) {
      await beforeRequest();
      const startedAt = Date.now();
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), requestOptions());
        if (!response.Body || response.ContentLength === undefined) throw new Error(`Incomplete asset GET: ${key}`);
        const body = response.Body;
        if (!(body instanceof Readable)) throw new Error(`Asset GET is not a readable stream: ${key}`);
        return {
          bytes: response.ContentLength,
          body: boundedAssetBody(body, key, 60_000 - (Date.now() - startedAt)),
          contentType: response.ContentType,
          cacheControl: response.CacheControl,
          contentDisposition: response.ContentDisposition,
          contentEncoding: response.ContentEncoding,
          contentLanguage: response.ContentLanguage,
          expires: response.Expires,
          metadata: response.Metadata,
        };
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          '$metadata' in error &&
          (error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode === 404
        )
          return undefined;
        throw error;
      }
    },
    async put(key, contents, metadata, checksum) {
      await beforeRequest();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: contents,
          ContentLength: contents.byteLength,
          IfNoneMatch: '*',
          ChecksumSHA256: checksum,
          ContentType: metadata.contentType,
          CacheControl: metadata.cacheControl,
          ContentDisposition: metadata.contentDisposition,
          ContentEncoding: metadata.contentEncoding,
          ContentLanguage: metadata.contentLanguage,
          Expires: metadata.expires,
          Metadata: metadata.metadata,
        }),
        requestOptions(),
      );
    },
  };
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const mode = parseMigrationMode(arguments_);
  const legacyEndpoint = requiredEnvironment('STATIC_ASSETS_LEGACY_AWS_ENDPOINT_URL');
  const r2Endpoint = requiredEnvironment('STATIC_ASSETS_R2_AWS_ENDPOINT_URL');
  assertMigrationEndpoints(legacyEndpoint, r2Endpoint);
  const legacyBucket = requiredEnvironment('STATIC_ASSETS_LEGACY_S3_BUCKET_NAME');
  if (legacyBucket !== 'boardsesh-static-assets')
    throw new Error('Historical migration requires boardsesh-static-assets source bucket');
  const source = new S3Client({
    endpoint: legacyEndpoint,
    region: requiredEnvironment('STATIC_ASSETS_LEGACY_AWS_REGION'),
    maxAttempts: 1,
    credentials: {
      accessKeyId: requiredEnvironment('STATIC_ASSETS_LEGACY_AWS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('STATIC_ASSETS_LEGACY_AWS_SECRET_ACCESS_KEY'),
    },
  });
  const destination = new S3Client({
    endpoint: r2Endpoint,
    region: 'auto',
    maxAttempts: 1,
    credentials: {
      accessKeyId: requiredEnvironment('STATIC_ASSETS_R2_AWS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('STATIC_ASSETS_R2_AWS_SECRET_ACCESS_KEY'),
    },
  });
  try {
    const summary = await migrateStaticAssets(
      createAssetStore(source, legacyBucket),
      createAssetStore(destination, 'boardsesh-static-assets'),
      mode,
    );
    console.log(JSON.stringify({ mode, ...summary }));
  } finally {
    source.destroy();
    destination.destroy();
  }
}

export function assertMigrationEndpoints(legacyEndpoint: string, r2Endpoint: string): void {
  const source = new URL(legacyEndpoint);
  const destination = new URL(r2Endpoint);
  if (
    destination.protocol !== 'https:' ||
    !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(destination.hostname) ||
    destination.username ||
    destination.password ||
    destination.port ||
    destination.search ||
    destination.hash ||
    destination.pathname !== '/'
  )
    throw new Error('Destination must be an R2 HTTPS account endpoint');
  if (
    source.protocol !== 'https:' ||
    !['t3.storage.dev', 'fly.storage.tigris.dev'].includes(source.hostname) ||
    source.username ||
    source.password ||
    source.port ||
    source.search ||
    source.hash ||
    source.pathname !== '/'
  ) {
    throw new Error('Historical migration requires the pre-cutover legacy HTTPS endpoint');
  }
}

export function migrationErrorMessage(error: unknown): string {
  // SDK errors can contain signed request details; diagnostics never print credentials.
  return error instanceof Error &&
    /^(Missing required|Missing buffered source asset:|Supported flags|Choose exactly|Unknown immutable|Duplicate asset|Incomplete asset|Invalid or oversized|Asset body|Asset GET is not a readable stream:|Asset listing contains an object without a key$|Corrupt immutable|Missing historical|Source asset|Destination asset|Historical asset|Conditional-write|Empty historical|Destination must|Historical migration)/.test(
      error.message,
    )
    ? error.message.slice(0, 240)
    : 'Storage request failed; check credentials, endpoint, and connectivity';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`Static asset migration failed: ${migrationErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
