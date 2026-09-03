import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const sendMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = sendMock;
  },
  PutObjectCommand: class {},
  DeleteObjectCommand: class {
    constructor(public input: { Bucket: string; Key: string }) {}
  },
  GetObjectCommand: class {},
  HeadObjectCommand: class {},
  ListObjectsV2Command: class {},
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: loggerWarnMock, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { deleteUserAvatarsFromS3 } = await import('../s3');
const { ALLOWED_IMAGE_SIZES, resizedVariantKey } = await import('../../lib/image-resize');

/** Every key a stale extension now owns: the base object plus each resize variant. */
function keysFor(userId: string, extension: string): string[] {
  const baseKey = `avatars/${userId}.${extension}`;
  return [baseKey, ...ALLOWED_IMAGE_SIZES.map((size) => resizedVariantKey(baseKey, size))];
}

const USER_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.stubEnv('AWS_S3_BUCKET_NAME', 'test-bucket');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('deleteUserAvatarsFromS3', () => {
  it('skips the extension of the freshly written avatar', async () => {
    sendMock.mockResolvedValue({});

    await deleteUserAvatarsFromS3(USER_ID, 'jpg');

    const deleteCommands = sendMock.mock.calls.map((call) => call[0] as { input: { Key: string } });
    const deletedKeys = deleteCommands.map((command) => command.input.Key);
    // Variants are keyed off the BASE key, so a stale `.png` leaves
    // `.png@64.jpg` behind that nothing can ever reach again — it has to go too.
    expect(deletedKeys.sort()).toEqual(
      [...keysFor(USER_ID, 'gif'), ...keysFor(USER_ID, 'png'), ...keysFor(USER_ID, 'webp')].sort(),
    );
    expect(deletedKeys).not.toContain(`avatars/${USER_ID}.jpg`);
    expect(deletedKeys).not.toContain(resizedVariantKey(`avatars/${USER_ID}.jpg`, 64));
  });

  it('deletes every extension when no keepExt is given', async () => {
    sendMock.mockResolvedValue({});

    await deleteUserAvatarsFromS3(USER_ID);

    const deletedKeys = sendMock.mock.calls.map((call) => (call[0] as { input: { Key: string } }).input.Key);
    expect(deletedKeys.sort()).toEqual(
      ['gif', 'jpg', 'png', 'webp'].flatMap((extension) => keysFor(USER_ID, extension)).sort(),
    );
  });

  it('logs a warning and resolves when a delete fails (new avatar is already saved)', async () => {
    sendMock.mockRejectedValue(new Error('S3 unavailable'));

    await expect(deleteUserAvatarsFromS3(USER_ID, 'jpg')).resolves.toBeUndefined();

    // Three stale extensions, each with a base object and one variant per size.
    expect(loggerWarnMock).toHaveBeenCalledTimes(3 * (1 + ALLOWED_IMAGE_SIZES.length));
    expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining(`avatars/${USER_ID}.png`), expect.any(Error));
  });
});
