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
  };
});

const ORIGINAL_ENV = { ...process.env };

describe('s3 storage', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      AWS_ACCESS_KEY_ID: 'test-access-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      AWS_DEFAULT_REGION: 'us-east-1',
      AWS_ENDPOINT_URL: 'http://s3.test',
      AWS_S3_BUCKET_NAME: 'boardsesh-test-bucket',
    };
    awsMocks.clientConfig.mockClear();
    awsMocks.send.mockReset();
  });

  it('treats fake AWS environment variables as configured storage', async () => {
    const { getPublicUrl, isS3Configured } = await import('./s3');

    expect(isS3Configured()).toBe(true);
    expect(getPublicUrl('user-data-exports/user-1/kilter/2026-W19.json')).toBe(
      'http://s3.test/boardsesh-test-bucket/user-data-exports/user-1/kilter/2026-W19.json',
    );
  });

  it('uploads private user exports to the fake bucket without a public ACL', async () => {
    const { uploadToS3 } = await import('./s3');

    awsMocks.send.mockResolvedValueOnce({});
    const body = Buffer.from('{"ascents":[]}');
    const key = 'user-data-exports/user-1/kilter/2026-W19.json';

    await expect(
      uploadToS3(body, key, 'application/json', {
        cacheControl: 'private, no-store',
        acl: null,
      }),
    ).resolves.toEqual({
      key,
      url: `http://s3.test/boardsesh-test-bucket/${key}`,
    });

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
    const command = awsMocks.send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toEqual({
      Bucket: 'boardsesh-test-bucket',
      Key: key,
      Body: body,
      ContentType: 'application/json',
      CacheControl: 'private, no-store',
    });
    expect(command.input).not.toHaveProperty('ACL');
  });

  it('reads object metadata from the fake bucket with a HeadObject command', async () => {
    const { getS3ObjectMetadata } = await import('./s3');

    const lastModified = new Date('2026-05-07T12:00:00Z');
    awsMocks.send.mockResolvedValueOnce({
      ContentType: 'application/json',
      ContentLength: 123,
      LastModified: lastModified,
    });

    const metadata = await getS3ObjectMetadata('user-data-exports/user-1/kilter/2026-W19.json');

    expect(metadata).toEqual({
      contentType: 'application/json',
      contentLength: 123,
      lastModified,
    });
    const command = awsMocks.send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toEqual({
      Bucket: 'boardsesh-test-bucket',
      Key: 'user-data-exports/user-1/kilter/2026-W19.json',
    });
  });

  it('downloads objects from the fake bucket and returns null when S3 misses', async () => {
    const { getFromS3 } = await import('./s3');

    const stream = Readable.from(['{}']);
    awsMocks.send.mockResolvedValueOnce({
      Body: stream,
      ContentType: 'application/json',
      ContentLength: 2,
    });

    await expect(getFromS3('user-data-exports/user-1/kilter/2026-W19.json')).resolves.toEqual({
      stream,
      contentType: 'application/json',
      contentLength: 2,
    });

    awsMocks.send.mockRejectedValueOnce(new Error('not found'));
    await expect(getFromS3('missing.json')).resolves.toBeNull();
  });

  it('getFromS3Strict distinguishes a missing object (null) from a read failure (throws)', async () => {
    const { getFromS3Strict } = await import('./s3');

    // NoSuchKey / 404 shapes → null (the object genuinely does not exist).
    const noSuchKey = Object.assign(new Error('no such key'), { name: 'NoSuchKey' });
    awsMocks.send.mockRejectedValueOnce(noSuchKey);
    await expect(getFromS3Strict('missing.json')).resolves.toBeNull();

    const http404 = Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
    awsMocks.send.mockRejectedValueOnce(http404);
    await expect(getFromS3Strict('missing.json')).resolves.toBeNull();

    // Anything else (network/auth/throttle) must PROPAGATE — callers like the
    // snapshot manifest merge treat "missing" and "unreadable" very differently.
    awsMocks.send.mockRejectedValueOnce(new Error('connection reset'));
    await expect(getFromS3Strict('broken.json')).rejects.toThrow('connection reset');

    // The lenient getFromS3 still maps that same failure to null (caller contract).
    const { getFromS3 } = await import('./s3');
    awsMocks.send.mockRejectedValueOnce(new Error('connection reset'));
    await expect(getFromS3('broken.json')).resolves.toBeNull();
  });
});
