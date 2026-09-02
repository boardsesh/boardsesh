import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const awsMocks = vi.hoisted(() => ({
  clientConfig: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class MockCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    S3Client: class S3Client {
      constructor(config: unknown) {
        awsMocks.clientConfig(config);
      }

      send(command: unknown) {
        return awsMocks.send(command);
      }
    },
    PutObjectCommand: class PutObjectCommand extends MockCommand {},
    DeleteObjectCommand: class DeleteObjectCommand extends MockCommand {},
    GetObjectCommand: class GetObjectCommand extends MockCommand {},
    HeadObjectCommand: class HeadObjectCommand extends MockCommand {},
    ListObjectsV2Command: class ListObjectsV2Command extends MockCommand {},
  };
});

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

/** The pre-named-buckets `AWS_*` shape, which every handle still falls back to. */
const LEGACY_ENV = {
  AWS_ACCESS_KEY_ID: 'test-access-key',
  AWS_SECRET_ACCESS_KEY: 'test-secret-key',
  AWS_DEFAULT_REGION: 'us-east-1',
  AWS_ENDPOINT_URL: 'http://s3.test',
  AWS_S3_BUCKET_NAME: 'boardsesh-test-bucket',
};

/** A Cloudflare R2 bucket: virtual-hosted, no ACLs, public URL only via the CDN domain. */
const R2_MEDIA_ENV = {
  MEDIA_S3_BUCKET_NAME: 'boardsesh-user-media',
  MEDIA_AWS_ENDPOINT_URL: 'https://acct123.r2.cloudflarestorage.com',
  MEDIA_AWS_REGION: 'auto',
  MEDIA_AWS_ACCESS_KEY_ID: 'media-key',
  MEDIA_AWS_SECRET_ACCESS_KEY: 'media-secret',
  MEDIA_DISABLE_ACL: 'true',
  MEDIA_PUBLIC_BASE_URL: 'https://media.boardsesh.com',
};

const R2_PRIVATE_ENV = {
  PRIVATE_S3_BUCKET_NAME: 'boardsesh-user-private',
  PRIVATE_AWS_ENDPOINT_URL: 'https://acct123.r2.cloudflarestorage.com',
  PRIVATE_AWS_REGION: 'auto',
  PRIVATE_AWS_ACCESS_KEY_ID: 'private-key',
  PRIVATE_AWS_SECRET_ACCESS_KEY: 'private-secret',
  PRIVATE_DISABLE_ACL: 'true',
};

function setEnv(...overlays: Record<string, string>[]): void {
  process.env = Object.assign({ ...ORIGINAL_ENV }, ...overlays);
}

function lastCommandInput(index = 0): Record<string, unknown> {
  return (awsMocks.send.mock.calls[index][0] as { input: Record<string, unknown> }).input;
}

describe('s3 storage', () => {
  beforeEach(() => {
    vi.resetModules();
    setEnv(LEGACY_ENV);
    awsMocks.clientConfig.mockClear();
    awsMocks.send.mockReset();
  });

  describe('legacy AWS_* fallback', () => {
    // These cases are the contract that lets the named-bucket refactor deploy
    // as a genuine no-op: with only AWS_* set, every handle must behave exactly
    // as the single-client module did.

    it('treats fake AWS environment variables as configured storage', async () => {
      const { getPublicUrl, isS3Configured } = await import('../s3');

      expect(isS3Configured()).toBe(true);
      expect(getPublicUrl('private', 'user-data-exports/user-1/kilter/2026-W19.json')).toBe(
        'http://s3.test/boardsesh-test-bucket/user-data-exports/user-1/kilter/2026-W19.json',
      );
    });

    it('builds a path-style client for every handle', async () => {
      const { getBucketName } = await import('../s3');

      expect(getBucketName('media')).toBe('boardsesh-test-bucket');
      expect(getBucketName('private')).toBe('boardsesh-test-bucket');
      expect(getBucketName('snapshots')).toBe('boardsesh-test-bucket');
    });

    it('uploads private user exports to the fake bucket without a public ACL', async () => {
      const { uploadToS3 } = await import('../s3');

      awsMocks.send.mockResolvedValueOnce({});
      const body = Buffer.from('{"ascents":[]}');
      const key = 'user-data-exports/user-1/kilter/2026-W19.json';

      await expect(
        uploadToS3('private', body, key, 'application/json', {
          cacheControl: 'private, no-store',
          acl: null,
        }),
      ).resolves.toEqual({ key });

      expect(awsMocks.clientConfig).toHaveBeenCalledWith({
        endpoint: 'http://s3.test',
        region: 'us-east-1',
        credentials: {
          accessKeyId: 'test-access-key',
          secretAccessKey: 'test-secret-key',
        },
        forcePathStyle: true,
      });
      expect(awsMocks.send).toHaveBeenCalledTimes(1);
      expect(lastCommandInput()).toEqual({
        Bucket: 'boardsesh-test-bucket',
        Key: key,
        Body: body,
        ContentType: 'application/json',
        CacheControl: 'private, no-store',
      });
      expect(lastCommandInput()).not.toHaveProperty('ACL');
    });

    it('sends no ACL for the private bucket even without an explicit override', async () => {
      // The OCR test-data path uploads with no options at all. Before named
      // buckets that meant public-read, which was survivable only because the
      // Railway bucket ignores ACLs.
      const { uploadToS3 } = await import('../s3');

      awsMocks.send.mockResolvedValueOnce({});
      await uploadToS3('private', Buffer.from('{}'), 'moonboard-ocr-test-data/x/image.png', 'image/png');

      expect(Object.keys(lastCommandInput())).not.toContain('ACL');
    });

    it('still sends public-read by default, as it did before named buckets', async () => {
      const { uploadToS3 } = await import('../s3');

      awsMocks.send.mockResolvedValueOnce({});
      await uploadToS3('snapshots', Buffer.from('{}'), 'board-snapshots/v1/manifest.json', 'application/json');

      expect(lastCommandInput().ACL).toBe('public-read');
    });
  });

  describe('named buckets', () => {
    it('resolves each handle independently, with its own client and credentials', async () => {
      const { getBucketName } = await import('../s3');

      setEnv(LEGACY_ENV, R2_MEDIA_ENV, R2_PRIVATE_ENV);

      expect(getBucketName('media')).toBe('boardsesh-user-media');
      expect(getBucketName('private')).toBe('boardsesh-user-private');
      // Not given a SNAPSHOTS_* prefix, so it keeps falling back to AWS_*.
      expect(getBucketName('snapshots')).toBe('boardsesh-test-bucket');
    });

    it('constructs a distinct virtual-hosted client per handle', async () => {
      const { uploadToS3 } = await import('../s3');
      setEnv(LEGACY_ENV, R2_MEDIA_ENV, R2_PRIVATE_ENV);

      awsMocks.send.mockResolvedValue({});
      await uploadToS3('media', Buffer.from('a'), 'avatars/u1.jpg', 'image/jpeg');
      await uploadToS3('private', Buffer.from('b'), 'user-data-exports/u1/kilter/2026-W19.json', 'application/json');

      expect(awsMocks.clientConfig).toHaveBeenCalledTimes(2);
      expect(awsMocks.clientConfig).toHaveBeenNthCalledWith(1, {
        endpoint: 'https://acct123.r2.cloudflarestorage.com',
        region: 'auto',
        credentials: { accessKeyId: 'media-key', secretAccessKey: 'media-secret' },
        forcePathStyle: false,
      });
      expect(awsMocks.clientConfig).toHaveBeenNthCalledWith(2, {
        endpoint: 'https://acct123.r2.cloudflarestorage.com',
        region: 'auto',
        credentials: { accessKeyId: 'private-key', secretAccessKey: 'private-secret' },
        forcePathStyle: false,
      });
    });

    it('OMITS the ACL key entirely when the bucket disables ACLs', async () => {
      // R2 answers `x-amz-acl` with 501 NotImplemented for every value it does
      // not support, so `ACL: undefined` is not good enough — the key must be
      // absent from the command input. Getting this wrong fails 100% of uploads.
      const { uploadToS3 } = await import('../s3');
      setEnv(LEGACY_ENV, R2_MEDIA_ENV);

      awsMocks.send.mockResolvedValueOnce({});
      await uploadToS3('media', Buffer.from('a'), 'avatars/u1.jpg', 'image/jpeg');

      expect(Object.keys(lastCommandInput())).not.toContain('ACL');
    });

    it('sends no ACL for a prefixed private bucket with PRIVATE_DISABLE_ACL absent', async () => {
      // The legacy-mode equivalent of this case exists above. Both matter: the
      // OCR test-data path uploads with no options, so on any ACL-honouring
      // store a `public-read` default would publish user screenshots.
      const { uploadToS3 } = await import('../s3');
      const { PRIVATE_DISABLE_ACL: _omitted, ...privateWithoutFlag } = R2_PRIVATE_ENV;
      setEnv(LEGACY_ENV, privateWithoutFlag);

      awsMocks.send.mockResolvedValueOnce({});
      await uploadToS3('private', Buffer.from('{}'), 'moonboard-ocr-test-data/x/image.png', 'image/png');

      expect(Object.keys(lastCommandInput())).not.toContain('ACL');
    });

    it('serves public URLs from the CDN base, not the signed S3 endpoint', async () => {
      const { getPublicUrl } = await import('../s3');
      setEnv(LEGACY_ENV, R2_MEDIA_ENV);

      expect(getPublicUrl('media', 'beta-link-thumbnails/instagram/abc.jpg')).toBe(
        'https://media.boardsesh.com/beta-link-thumbnails/instagram/abc.jpg',
      );
    });

    it('refuses to invent a public URL for a prefixed bucket that has no public base', async () => {
      // The R2 S3 endpoint requires SigV4, so a derived URL would always 401.
      // Returning one anyway is how legacy direct-bucket URLs ended up
      // persisted in board_beta_links.thumbnail and needed a data backfill.
      const { getPublicUrl } = await import('../s3');
      setEnv(LEGACY_ENV, R2_PRIVATE_ENV);

      expect(() => getPublicUrl('private', 'user-data-exports/u1/kilter/2026-W19.json')).toThrow(
        /PRIVATE_PUBLIC_BASE_URL/,
      );
    });

    it('refuses to mix a prefixed bucket name with legacy credentials', async () => {
      const { getBucketName } = await import('../s3');
      setEnv(LEGACY_ENV, { MEDIA_S3_BUCKET_NAME: 'boardsesh-user-media' });

      expect(() => getBucketName('media')).toThrow(/MEDIA_AWS_ACCESS_KEY_ID and MEDIA_AWS_SECRET_ACCESS_KEY/);
    });

    it('resetStorageClients drops the cached config so a changed env is observed', async () => {
      const { getBucketName, resetStorageClients } = await import('../s3');

      expect(getBucketName('media')).toBe('boardsesh-test-bucket');

      setEnv(LEGACY_ENV, R2_MEDIA_ENV);
      expect(getBucketName('media')).toBe('boardsesh-test-bucket'); // still cached

      resetStorageClients();
      expect(getBucketName('media')).toBe('boardsesh-user-media');
    });
  });

  it('reads object metadata from the fake bucket with a HeadObject command', async () => {
    const { getS3ObjectMetadata } = await import('../s3');

    const lastModified = new Date('2026-05-07T12:00:00Z');
    awsMocks.send.mockResolvedValueOnce({
      ContentType: 'application/json',
      ContentLength: 123,
      LastModified: lastModified,
    });

    const metadata = await getS3ObjectMetadata('private', 'user-data-exports/user-1/kilter/2026-W19.json');

    expect(metadata).toEqual({
      contentType: 'application/json',
      contentLength: 123,
      lastModified,
    });
    expect(lastCommandInput()).toEqual({
      Bucket: 'boardsesh-test-bucket',
      Key: 'user-data-exports/user-1/kilter/2026-W19.json',
    });
  });

  it('downloads objects from the fake bucket and returns null when S3 misses', async () => {
    const { getFromS3 } = await import('../s3');

    const stream = Readable.from(['{}']);
    awsMocks.send.mockResolvedValueOnce({
      Body: stream,
      ContentType: 'application/json',
      ContentLength: 2,
    });

    await expect(getFromS3('private', 'user-data-exports/user-1/kilter/2026-W19.json')).resolves.toEqual({
      stream,
      contentType: 'application/json',
      contentLength: 2,
    });

    awsMocks.send.mockRejectedValueOnce(new Error('not found'));
    await expect(getFromS3('private', 'missing.json')).resolves.toBeNull();
  });

  it('getFromS3Strict distinguishes a missing object (null) from a read failure (throws)', async () => {
    const { getFromS3, getFromS3Strict } = await import('../s3');

    // NoSuchKey / 404 shapes → null (the object genuinely does not exist).
    const noSuchKey = Object.assign(new Error('no such key'), { name: 'NoSuchKey' });
    awsMocks.send.mockRejectedValueOnce(noSuchKey);
    await expect(getFromS3Strict('snapshots', 'missing.json')).resolves.toBeNull();

    const http404 = Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
    awsMocks.send.mockRejectedValueOnce(http404);
    await expect(getFromS3Strict('snapshots', 'missing.json')).resolves.toBeNull();

    // Anything else (network/auth/throttle) must PROPAGATE — callers like the
    // snapshot manifest merge treat "missing" and "unreadable" very differently.
    awsMocks.send.mockRejectedValueOnce(new Error('connection reset'));
    await expect(getFromS3Strict('snapshots', 'broken.json')).rejects.toThrow('connection reset');

    // The lenient getFromS3 still maps that same failure to null (caller contract).
    awsMocks.send.mockRejectedValueOnce(new Error('connection reset'));
    await expect(getFromS3('snapshots', 'broken.json')).resolves.toBeNull();
  });

  it('listS3Objects follows continuation tokens across pages and skips keyless entries', async () => {
    const { listS3Objects } = await import('../s3');

    const firstModified = new Date('2026-06-01T00:00:00Z');
    const secondModified = new Date('2026-06-02T00:00:00Z');
    awsMocks.send
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'board-snapshots/v1/kilter/1/a.db', Size: 10, LastModified: firstModified },
          { Size: 5 }, // keyless entry must be skipped, not crash
        ],
        IsTruncated: true,
        NextContinuationToken: 'token-2',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'board-snapshots/v1/kilter/1/b.db', Size: 20, LastModified: secondModified }],
        IsTruncated: false,
      });

    const objects = await listS3Objects('snapshots', 'board-snapshots/v1/');

    expect(objects).toEqual([
      { key: 'board-snapshots/v1/kilter/1/a.db', size: 10, lastModified: firstModified },
      { key: 'board-snapshots/v1/kilter/1/b.db', size: 20, lastModified: secondModified },
    ]);
    expect(awsMocks.send).toHaveBeenCalledTimes(2);
    expect(lastCommandInput(1).ContinuationToken).toBe('token-2');
    expect(lastCommandInput(1).Prefix).toBe('board-snapshots/v1/');
  });
});
