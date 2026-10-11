import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { createTutorialS3Client, tutorialPutObjectInput } from '../lib/instructional-video/publish';

describe('tutorial R2 upload wire contract', () => {
  it('sends supported integrity metadata without unsupported SHA or default CRC checksum headers', async () => {
    let requestHeaders: Record<string, string> = {};
    const client = createTutorialS3Client(
      {
        STATIC_ASSETS_AWS_ENDPOINT_URL: 'https://tutorial-test.r2.cloudflarestorage.com',
        STATIC_ASSETS_AWS_REGION: 'auto',
        STATIC_ASSETS_AWS_ACCESS_KEY_ID: 'local-test',
        STATIC_ASSETS_AWS_SECRET_ACCESS_KEY: 'local-test',
      },
      {
        handle: async (request: unknown) => {
          requestHeaders = (request as { headers: Record<string, string> }).headers;
          return { response: { statusCode: 200, headers: {}, body: new Uint8Array() } };
        },
      },
    );
    const body = Buffer.from('reviewed tutorial bytes');
    await client.send(
      new PutObjectCommand(
        tutorialPutObjectInput(
          'tutorial-assets',
          'tutorials/v1/test.mp4',
          body,
          'video/mp4',
          'public, max-age=31536000, immutable',
          true,
        ),
      ),
    );
    expect(requestHeaders['content-md5']).toBe(createHash('md5').update(body).digest('base64'));
    expect(requestHeaders['x-amz-meta-sha256']).toBe(createHash('sha256').update(body).digest('hex'));
    expect(requestHeaders['if-none-match']).toBe('*');
    expect(
      Object.keys(requestHeaders).filter(
        (name) => name.startsWith('x-amz-checksum-') || name === 'x-amz-sdk-checksum-algorithm' || name === 'x-amz-acl',
      ),
    ).toEqual([]);
    client.destroy();
  });
});
