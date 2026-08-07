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
    expect(deletedKeys.sort()).toEqual([`avatars/${USER_ID}.gif`, `avatars/${USER_ID}.png`, `avatars/${USER_ID}.webp`]);
  });

  it('logs a warning and resolves when a delete fails (new avatar is already saved)', async () => {
    sendMock.mockRejectedValue(new Error('S3 unavailable'));

    await expect(deleteUserAvatarsFromS3(USER_ID, 'jpg')).resolves.toBeUndefined();

    expect(loggerWarnMock).toHaveBeenCalledTimes(3);
    expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining(`avatars/${USER_ID}.png`), expect.any(Error));
  });
});
