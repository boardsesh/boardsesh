import { ListObjectsV2Command, type ListObjectsV2CommandOutput, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { LIST_PAGE_RETRY_DELAYS_MS, listRemoteStaticAssets } from '../upload-static-assets';

function mockListing(pages: (ListObjectsV2CommandOutput | Error)[]) {
  const send = vi.fn<(command: ListObjectsV2Command) => Promise<ListObjectsV2CommandOutput>>(async () => {
    const next = pages.shift();
    if (!next) throw new Error('listed past the last page');
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { send } as unknown as S3Client, send };
}

const page = (keys: string[], nextToken?: string): ListObjectsV2CommandOutput => ({
  Contents: keys.map((Key) => ({ Key, Size: 10 })),
  IsTruncated: nextToken !== undefined,
  NextContinuationToken: nextToken,
  $metadata: {},
});

describe('listRemoteStaticAssets', () => {
  it('retries a page R2 answered with unparseable XML and keeps the continuation token', async () => {
    const { client, send } = mockListing([
      page(['static/v1/a.webm'], 'token-2'),
      new Error('@aws-sdk XML parse error: unexpected content.'),
      page(['static/v1/b.webm']),
    ]);
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(listRemoteStaticAssets(client, 'bucket', async () => {}, { sleep })).resolves.toEqual([
      { key: 'static/v1/a.webm', bytes: 10 },
      { key: 'static/v1/b.webm', bytes: 10 },
    ]);
    expect(send.mock.calls.map(([command]) => command.input.ContinuationToken)).toEqual([
      undefined,
      'token-2',
      'token-2',
    ]);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([LIST_PAGE_RETRY_DELAYS_MS[0]]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('throws the R2 error after three failed tries of the same page', async () => {
    const failure = new Error('@aws-sdk XML parse error: unexpected content.');
    const { client, send } = mockListing([failure, failure, failure]);
    const beforeRequest = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(listRemoteStaticAssets(client, 'bucket', beforeRequest, { sleep: async () => {} })).rejects.toBe(
      failure,
    );
    expect(send).toHaveBeenCalledTimes(3);
    // Every try goes through the request-start limiter, retries included.
    expect(beforeRequest).toHaveBeenCalledTimes(3);
    expect(LIST_PAGE_RETRY_DELAYS_MS).toEqual([2_000, 8_000]);
    warn.mockRestore();
  });
});
