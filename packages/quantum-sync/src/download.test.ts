import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { resolveQuantumSyncContract } from './config';
import { downloadQuantumChunk, isPublicIpAddress } from './download';
import type { QuantumHostnameResolver, QuantumManifestChunk } from './types';
import { decompressQuantumSnapshot } from './zstd';

const resolvePublicHost: QuantumHostnameResolver = async () => [{ address: '93.184.216.34', family: 4 }];

function chunkFor(
  bytes: Uint8Array,
  urls = ['https://one.example/snapshot', 'https://two.example/snapshot'],
): QuantumManifestChunk {
  return {
    name: 'quantum_snapshot_v1',
    type: 'quantum',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    urls,
  };
}

describe('Quantum snapshot download and decompression', () => {
  it('defaults to bounded artifact sizes', () => {
    const limits = resolveQuantumSyncContract({}, {}).limits;
    expect(limits.maxCompressedBytes).toBe(64 * 1024 * 1024);
    expect(limits.maxDecompressedBytes).toBe(256 * 1024 * 1024);
    expect(limits.mirrorTimeoutMs).toBe(60_000);
  });

  it('falls back between HTTPS mirrors and verifies a streamed hash and exact size', async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5);
    const fetchMirror = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('one.example')) return new Response('nope', { status: 503 });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 2));
          controller.enqueue(bytes.subarray(2));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-length': String(bytes.byteLength) } });
    });

    const result = await downloadQuantumChunk(chunkFor(bytes), resolveQuantumSyncContract({}, {}).limits, {
      fetch: fetchMirror,
      resolveHostname: resolvePublicHost,
    });
    try {
      expect(Uint8Array.from(await readFile(result.filePath))).toEqual(bytes);
      expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
      expect('bytes' in result).toBe(false);
      expect(result.mirrorUrl).toBe('https://two.example/snapshot');
      expect(fetchMirror).toHaveBeenCalledTimes(2);
      expect(fetchMirror.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    } finally {
      const path = result.filePath;
      await result.dispose();
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('abandons a mirror that stalls before response headers and tries the next mirror', async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const limits = resolveQuantumSyncContract({ limits: { mirrorTimeoutMs: 25 } }, {}).limits;
    const fetchMirror = vi.fn((url: string) => {
      if (url.includes('one.example')) return new Promise<Response>(() => {});
      return Promise.resolve(new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }));
    });

    const result = await downloadQuantumChunk(chunkFor(bytes), limits, {
      fetch: fetchMirror,
      resolveHostname: resolvePublicHost,
    });
    try {
      expect(result.mirrorUrl).toBe('https://two.example/snapshot');
      expect(fetchMirror).toHaveBeenCalledTimes(2);
    } finally {
      await result.dispose();
    }
  });

  it('abandons a mirror that stalls during its body and tries the next mirror', async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const limits = resolveQuantumSyncContract({ limits: { mirrorTimeoutMs: 25 } }, {}).limits;
    let stalledBodyCancelled = false;
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 1));
      },
      cancel() {
        stalledBodyCancelled = true;
      },
    });
    const fetchMirror = vi
      .fn()
      .mockResolvedValueOnce(new Response(stalledBody))
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }));

    const result = await downloadQuantumChunk(chunkFor(bytes), limits, {
      fetch: fetchMirror,
      resolveHostname: resolvePublicHost,
    });
    try {
      expect(result.mirrorUrl).toBe('https://two.example/snapshot');
      expect(fetchMirror).toHaveBeenCalledTimes(2);
      expect(stalledBodyCancelled).toBe(true);
    } finally {
      await result.dispose();
    }
  });

  it('rejects an incorrect hash and bytes beyond the signed size', async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const wrongHashChunk = { ...chunkFor(bytes, ['https://one.example/snapshot']), sha256: '0'.repeat(64) };
    await expect(
      downloadQuantumChunk(wrongHashChunk, resolveQuantumSyncContract({}, {}).limits, {
        fetch: async () => new Response(bytes),
        resolveHostname: resolvePublicHost,
      }),
    ).rejects.toMatchObject({ code: 'MIRROR_DOWNLOAD_FAILED' });

    await expect(
      downloadQuantumChunk(
        chunkFor(bytes, ['https://one.example/snapshot']),
        resolveQuantumSyncContract({}, {}).limits,
        {
          fetch: async () => new Response(Uint8Array.of(1, 2, 3, 4)),
          resolveHostname: resolvePublicHost,
        },
      ),
    ).rejects.toMatchObject({ code: 'MIRROR_DOWNLOAD_FAILED' });
  });

  it('streams zstd output through a hard decompressed-size cap', async () => {
    const plain = new TextEncoder().encode('synthetic quantum snapshot payload');
    const compressed = Uint8Array.from(zstdCompressSync(plain));
    const decoded = await decompressQuantumSnapshot(compressed, plain.byteLength);
    try {
      expect(Uint8Array.from(await readFile(decoded.filePath))).toEqual(plain);
      expect((await stat(decoded.filePath)).mode & 0o777).toBe(0o600);
      expect('bytes' in decoded).toBe(false);
      expect(decoded.sha256).toBe(createHash('sha256').update(plain).digest('hex'));
    } finally {
      await decoded.dispose();
    }

    await expect(decompressQuantumSnapshot(compressed, plain.byteLength - 1)).rejects.toMatchObject({
      code: 'DECOMPRESSION_LIMIT_EXCEEDED',
    });
  });

  it('follows only same-origin manual redirects and validates every target before requesting it', async () => {
    const bytes = Uint8Array.of(8, 9, 10);
    const fetchMirror = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/final.zst' } }))
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }));
    const result = await downloadQuantumChunk(
      chunkFor(bytes, ['https://mirror.example/start.zst']),
      resolveQuantumSyncContract({}, {}).limits,
      { fetch: fetchMirror, resolveHostname: resolvePublicHost },
    );
    try {
      expect(fetchMirror.mock.calls.map(([url]) => url)).toEqual([
        'https://mirror.example/start.zst',
        'https://mirror.example/final.zst',
      ]);
      expect(fetchMirror.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
    } finally {
      await result.dispose();
    }
  });

  it('rejects cross-origin, private, and DNS-rebound redirect targets before the next request', async () => {
    const bytes = Uint8Array.of(1);
    const crossOriginFetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://other.example/private' } }),
    );
    await expect(
      downloadQuantumChunk(
        chunkFor(bytes, ['https://mirror.example/start']),
        resolveQuantumSyncContract({}, {}).limits,
        { fetch: crossOriginFetch, resolveHostname: resolvePublicHost },
      ),
    ).rejects.toMatchObject({ code: 'MIRROR_DOWNLOAD_FAILED' });
    expect(crossOriginFetch).toHaveBeenCalledOnce();

    for (const unsafeLocation of [
      'https://169.254.169.254/latest/meta-data',
      'https://user:secret@mirror.example/private',
    ]) {
      const redirectFetch = vi.fn(
        async () => new Response(null, { status: 302, headers: { location: unsafeLocation } }),
      );
      await expect(
        downloadQuantumChunk(
          chunkFor(bytes, ['https://mirror.example/start']),
          resolveQuantumSyncContract({}, {}).limits,
          { fetch: redirectFetch, resolveHostname: resolvePublicHost },
        ),
      ).rejects.toMatchObject({ code: 'MIRROR_DOWNLOAD_FAILED' });
      expect(redirectFetch).toHaveBeenCalledOnce();
    }

    const reboundResolver = vi
      .fn<QuantumHostnameResolver>()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const reboundFetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    await expect(
      downloadQuantumChunk(
        chunkFor(bytes, ['https://mirror.example/start']),
        resolveQuantumSyncContract({}, {}).limits,
        { fetch: reboundFetch, resolveHostname: reboundResolver },
      ),
    ).rejects.toMatchObject({ code: 'MIRROR_DOWNLOAD_FAILED' });
    expect(reboundResolver).toHaveBeenCalledTimes(2);
    expect(reboundFetch).toHaveBeenCalledOnce();

    const privateFetch = vi.fn(async () => new Response(bytes));
    await expect(
      downloadQuantumChunk(chunkFor(bytes, ['https://127.0.0.1/snapshot']), resolveQuantumSyncContract({}, {}).limits, {
        fetch: privateFetch,
      }),
    ).rejects.toMatchObject({ code: 'MIRROR_DOWNLOAD_FAILED' });
    expect(privateFetch).not.toHaveBeenCalled();
    await expect(
      downloadQuantumChunk(
        chunkFor(bytes, ['https://2130706433/snapshot']),
        resolveQuantumSyncContract({}, {}).limits,
        {
          fetch: privateFetch,
        },
      ),
    ).rejects.toMatchObject({ code: 'MIRROR_DOWNLOAD_FAILED' });
    expect(privateFetch).not.toHaveBeenCalled();
  });

  it('classifies public and non-public IPv4 and IPv6 targets', () => {
    expect(isPublicIpAddress('93.184.216.34')).toBe(true);
    expect(isPublicIpAddress('10.0.0.1')).toBe(false);
    expect(isPublicIpAddress('169.254.169.254')).toBe(false);
    expect(isPublicIpAddress('127.0.0.1')).toBe(false);
    expect(isPublicIpAddress('2001:4860:4860::8888')).toBe(true);
    expect(isPublicIpAddress('::1')).toBe(false);
    expect(isPublicIpAddress('fe80::1')).toBe(false);
    expect(isPublicIpAddress('fc00::1')).toBe(false);
    expect(isPublicIpAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIpAddress('64:ff9b::7f00:1')).toBe(false);
    expect(isPublicIpAddress('2002:7f00:1::')).toBe(false);
  });
});
