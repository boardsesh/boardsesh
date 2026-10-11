import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const captured = vi.hoisted(() => ({ headers: {} as Record<string, string>, bytes: Buffer.alloc(0) }));
// Keep the real SDK signing/checksum middleware; intercept only the transport.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class extends actual.S3Client {
      constructor(options: ConstructorParameters<typeof actual.S3Client>[0]) {
        super({
          ...options,
          requestHandler: {
            handle: async (request: { headers: Record<string, string>; body: AsyncIterable<Uint8Array> }) => {
              captured.headers = request.headers;
              const chunks: Buffer[] = [];
              for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
              captured.bytes = Buffer.concat(chunks);
              return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
            },
          },
        });
      }
    },
  };
});
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn() } }));
const { uploadStreamToS3, resetStorageClients } = await import('../s3');
afterEach(() => {
  vi.unstubAllEnvs();
  resetStorageClients();
});
describe('known-length media stream transport', () => {
  it('preserves Content-Length and avoids AWS checksum trailers unsupported by R2', async () => {
    vi.stubEnv('MEDIA_S3_BUCKET_NAME', 'boardsesh-user-media');
    vi.stubEnv('MEDIA_AWS_ENDPOINT_URL', 'https://acct.r2.cloudflarestorage.com');
    vi.stubEnv('MEDIA_AWS_REGION', 'auto');
    vi.stubEnv('MEDIA_AWS_ACCESS_KEY_ID', 'test-key');
    vi.stubEnv('MEDIA_AWS_SECRET_ACCESS_KEY', 'test-secret');
    vi.stubEnv('MEDIA_DISABLE_ACL', 'true');
    const bytes = Buffer.from('recording-container-original-bytes');
    await uploadStreamToS3('media', Readable.from([bytes]), bytes.length, 'feedback-recordings/id.mp4', 'video/mp4');
    expect(captured.bytes).toEqual(bytes);
    expect(captured.headers['content-length']).toBe(String(bytes.length));
    expect(captured.headers['content-encoding']).toBeUndefined();
    expect(captured.headers['x-amz-trailer']).toBeUndefined();
    expect(captured.headers['transfer-encoding']).toBeUndefined();
    expect(captured.headers['x-amz-acl']).toBeUndefined();
    expect(captured.headers['content-type']).toBe('video/mp4');
  });
});
