import { zstdCompressSync } from 'node:zlib';
import { access } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { openNodeQuantumSqlite } from './sqlite';
import { runQuantumSyncOnce } from './sync';
import { createSyntheticManifestEvent, createSyntheticQuantumSqlite } from './test-fixtures';
import { nodeZstdStreamDecoder } from './zstd';

describe('runQuantumSyncOnce', () => {
  it('imports only normalized immutable rows after every verification stage succeeds', async () => {
    const sqliteBytes = await createSyntheticQuantumSqlite();
    const compressed = Uint8Array.from(zstdCompressSync(sqliteBytes));
    const event = createSyntheticManifestEvent({ compressed });
    const importSnapshot = vi.fn(async (snapshot: { summary: { routes: number } }) => snapshot.summary.routes);

    const result = await runQuantumSyncOnce(
      {
        loadEvents: async () => [event],
        verifyEventSignature: async () => true,
        fetch: async () => new Response(compressed, { headers: { 'content-length': String(compressed.byteLength) } }),
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        importSnapshot,
      },
      { environment: {}, now: () => new Date('2027-02-01T00:00:00.000Z') },
    );

    expect(result.importResult).toBe(1);
    expect(result.snapshot).toMatchObject({
      eventId: event.id,
      source: 'ewalls-authorized-snapshot',
      chunkName: 'quantum_snapshot_v1',
      compressedSize: compressed.byteLength,
    });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.rows.routes[0])).toBe(true);
    expect(importSnapshot).toHaveBeenCalledOnce();
  });

  it('never calls the importer when event verification fails', async () => {
    const compressed = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 1);
    const event = createSyntheticManifestEvent({ compressed });
    const importSnapshot = vi.fn(async () => undefined);

    await expect(
      runQuantumSyncOnce(
        {
          loadEvents: async () => [event],
          verifyEventSignature: async () => false,
          fetch: async () => new Response(compressed),
          importSnapshot,
        },
        { environment: {}, now: () => new Date('2027-02-01T00:00:00.000Z') },
      ),
    ).rejects.toMatchObject({ code: 'NOSTR_NO_VALID_MANIFEST' });
    expect(importSnapshot).not.toHaveBeenCalled();
  });

  it('cleans both private artifact files when the importer fails', async () => {
    const sqliteBytes = await createSyntheticQuantumSqlite();
    const compressed = Uint8Array.from(zstdCompressSync(sqliteBytes));
    const event = createSyntheticManifestEvent({ compressed });
    let downloadedPath: string | null = null;
    let decompressedPath: string | null = null;

    await expect(
      runQuantumSyncOnce(
        {
          loadEvents: async () => [event],
          verifyEventSignature: async () => true,
          fetch: async () => new Response(compressed, { headers: { 'content-length': String(compressed.byteLength) } }),
          resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
          zstdDecoder: (filePath, signal) => {
            downloadedPath = filePath;
            return nodeZstdStreamDecoder(filePath, signal);
          },
          openSqlite: (filePath) => {
            decompressedPath = filePath;
            return openNodeQuantumSqlite(filePath);
          },
          importSnapshot: async () => {
            throw new Error('synthetic import failure');
          },
        },
        { environment: {}, now: () => new Date('2027-02-01T00:00:00.000Z') },
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_FAILED' });

    if (!downloadedPath || !decompressedPath) throw new Error('Expected both temporary artifact paths.');
    await expect(access(downloadedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(decompressedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
