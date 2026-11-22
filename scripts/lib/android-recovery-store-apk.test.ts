import { describe, expect, it, vi } from 'vitest';
import { readGeneratedPlayApk, selectGeneratedApkDownload } from './android-recovery-store-apk';

const metadata = {
  generatedApks: [
    {
      generatedSplitApks: [
        { moduleName: 'base', splitId: 'config.en', downloadId: 'language' },
        { moduleName: 'base', splitId: '', downloadId: 'base/id' },
      ],
    },
  ],
};

describe('Play APK recovery evidence', () => {
  it('selects a universal or main base APK, including protobuf-omitted split IDs', () => {
    expect(selectGeneratedApkDownload(metadata)).toBe('base/id');
    expect(
      selectGeneratedApkDownload({ generatedApks: [{ generatedUniversalApk: { downloadId: 'universal' } }] }),
    ).toBe('universal');
    expect(
      selectGeneratedApkDownload({
        generatedApks: [{ generatedSplitApks: [{ moduleName: 'base', downloadId: 'base' }] }],
      }),
    ).toBe('base');
    for (const invalid of [
      null,
      {},
      { generatedApks: [] },
      { generatedApks: [{ generatedSplitApks: [{ moduleName: 'feature', downloadId: 'feature' }] }] },
    ])
      expect(() => selectGeneratedApkDownload(invalid)).toThrow();
  });

  it('uses bounded authenticated GETs for the exact versionCode without redirects or edits', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    expect(await readGeneratedPlayApk('private-token', '2001879', { fetchImpl })).toEqual(Buffer.from([1, 2, 3]));
    expect(fetchImpl.mock.calls.map(([url]) => (url instanceof Request ? url.url : url.toString()))).toEqual([
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.boardsesh.app/generatedApks/2001879',
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.boardsesh.app/generatedApks/2001879/downloads/base%2Fid:download?alt=media',
    ]);
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options).toMatchObject({
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: 'Bearer private-token' },
      });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.body).toBeUndefined();
    }
  });

  it('rejects HTTP failures, empty bodies and oversized downloads without exposing responses', async () => {
    for (const response of [
      new Response('private-token', { status: 503 }),
      new Response(new Uint8Array()),
      new Response(new Uint8Array([1, 2]), { headers: { 'content-length': '2' } }),
      new Response(new Uint8Array([1, 2])),
    ]) {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(metadata))
        .mockResolvedValueOnce(response);
      await expect(readGeneratedPlayApk('token', '2001879', { fetchImpl, maxBytes: 1 })).rejects.toThrow(
        /HTTP 503|empty|size bound/,
      );
    }
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-token'));
    await expect(readGeneratedPlayApk('private-token', '2001879', { fetchImpl })).rejects.toThrow(
      'Generated Play APK request failed.',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed identities before accessing Play', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const versionCode of ['0', '../other', '9007199254740992'])
      await expect(readGeneratedPlayApk('token', versionCode, { fetchImpl })).rejects.toThrow(/versionCode/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts a failed download stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('private-token'));
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(new Response(body));
    await expect(readGeneratedPlayApk('private-token', '2001879', { fetchImpl })).rejects.toThrow(
      'Generated Play APK body read failed.',
    );
  });
});
