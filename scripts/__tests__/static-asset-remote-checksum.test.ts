import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { STATIC_ASSET_CACHE_CONTROL } from '../lib/static-asset-upload';
import { validateRemoteAsset } from '../upload-static-assets';

const contents = Buffer.from('homepage showcase video');
const sha256 = createHash('sha256').update(contents).digest('hex');
const asset = {
  logicalPath: '/videos/home/showcase-9x16-lite.webm',
  objectKey: `static/v1/${sha256}.webm`,
  sha256,
  bytes: contents.byteLength,
  contentType: 'video/webm',
  nativeBundle: false,
} as const;
const headMetadata = {
  ContentLength: asset.bytes,
  ContentType: asset.contentType,
  CacheControl: STATIC_ASSET_CACHE_CONTROL,
  $metadata: {},
};

function downloadBody(downloadedContents: Uint8Array): NonNullable<GetObjectCommandOutput['Body']> {
  return {
    transformToWebStream: () => new Response(Uint8Array.from(downloadedContents).buffer).body,
  } as unknown as NonNullable<GetObjectCommandOutput['Body']>;
}

function mockStorage() {
  const send =
    vi.fn<
      (
        command: HeadObjectCommand | GetObjectCommand,
        options?: { abortSignal: AbortSignal },
      ) => Promise<HeadObjectCommandOutput | GetObjectCommandOutput>
    >();
  const client = { send } as unknown as S3Client;
  const beforeRequest = vi.fn(async () => {});
  return { client, send, beforeRequest };
}

describe('signed static asset checksum validation', () => {
  it('verifies a pre-existing showcase video without a stored HEAD checksum', async () => {
    const { client, send, beforeRequest } = mockStorage();
    send.mockResolvedValueOnce(headMetadata).mockResolvedValueOnce({ Body: downloadBody(contents), $metadata: {} });

    await expect(validateRemoteAsset(client, 'static-assets', asset, beforeRequest)).resolves.toBeUndefined();

    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[1][0].input).toEqual({ Bucket: 'static-assets', Key: asset.objectKey });
    expect(send.mock.calls[1][1]).toEqual({ abortSignal: expect.any(AbortSignal) });
    expect(beforeRequest).toHaveBeenCalledTimes(2);
  });

  it('does not download assets whose stored checksum matches', async () => {
    const { client, send, beforeRequest } = mockStorage();
    send.mockResolvedValueOnce({ ...headMetadata, ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64') });

    await expect(validateRemoteAsset(client, 'static-assets', asset, beforeRequest)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(beforeRequest).toHaveBeenCalledOnce();
  });

  it('rejects a stored checksum mismatch without trying the fallback', async () => {
    const { client, send, beforeRequest } = mockStorage();
    send.mockResolvedValueOnce({ ...headMetadata, ChecksumSHA256: 'wrong-checksum' });

    await expect(validateRemoteAsset(client, 'static-assets', asset, beforeRequest)).rejects.toThrow(
      'HEAD checksum mismatch',
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects corrupt downloaded bytes even when their size matches', async () => {
    const { client, send, beforeRequest } = mockStorage();
    send
      .mockResolvedValueOnce(headMetadata)
      .mockResolvedValueOnce({ Body: downloadBody(Buffer.alloc(asset.bytes)), $metadata: {} });

    await expect(validateRemoteAsset(client, 'static-assets', asset, beforeRequest)).rejects.toThrow(
      'GET checksum mismatch',
    );
  });

  it('rejects truncated and oversized downloads', async () => {
    for (const downloadedBytes of [asset.bytes - 1, asset.bytes + 1]) {
      const { client, send, beforeRequest } = mockStorage();
      send
        .mockResolvedValueOnce(headMetadata)
        .mockResolvedValueOnce({ Body: downloadBody(Buffer.alloc(downloadedBytes)), $metadata: {} });

      await expect(validateRemoteAsset(client, 'static-assets', asset, beforeRequest)).rejects.toThrow(
        downloadedBytes < asset.bytes ? 'GET size mismatch' : 'exceeds the expected',
      );
    }
  });

  it('still rejects incorrect HEAD metadata when downloaded bytes match', async () => {
    const { client, send, beforeRequest } = mockStorage();
    send
      .mockResolvedValueOnce({ ...headMetadata, CacheControl: 'public, max-age=60' })
      .mockResolvedValueOnce({ Body: downloadBody(contents), $metadata: {} });

    await expect(validateRemoteAsset(client, 'static-assets', asset, beforeRequest)).rejects.toThrow(
      'Cache-Control mismatch',
    );
  });

  it('fails closed when the signed GET is denied or has no body', async () => {
    const denied = mockStorage();
    denied.send.mockResolvedValueOnce(headMetadata).mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(validateRemoteAsset(denied.client, 'static-assets', asset, denied.beforeRequest)).rejects.toThrow(
      'AccessDenied',
    );

    const empty = mockStorage();
    empty.send.mockResolvedValueOnce(headMetadata).mockResolvedValueOnce({ $metadata: {} });
    await expect(validateRemoteAsset(empty.client, 'static-assets', asset, empty.beforeRequest)).rejects.toThrow(
      'GET body missing',
    );
  });
});
