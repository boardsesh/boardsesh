import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashSourceMapExport, uploadMobileSourceMaps } from './mobile-upload-sourcemaps';
import { publishArchivedOta } from './mobile-ota-promote';
import { retryArchivedOta } from './mobile-ota-retry';

vi.mock('./mobile-upload-sourcemaps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-upload-sourcemaps')>()),
  uploadMobileSourceMaps: vi.fn(),
}));
vi.mock('./mobile-ota-promote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-ota-promote')>()),
  publishArchivedOta: vi.fn(),
}));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('retained OTA publication integrity', () => {
  it.each(['map', 'asset', 'extra', 'missing'])('rejects %s tampering before upload or publication', async (tamper) => {
    const directory = mkdtempSync(join(tmpdir(), 'boardsesh-retry-integrity-'));
    directories.push(directory);
    const exportDir = join(directory, 'export');
    mkdirSync(exportDir);
    const mapPath = join(exportDir, 'main.hbc.map');
    const assetPath = join(exportDir, 'asset.png');
    const debugId = '11111111-1111-1111-1111-111111111111';
    writeFileSync(join(exportDir, 'main.hbc'), `Hermes ${debugId}`);
    writeFileSync(mapPath, JSON.stringify({ debug_id: debugId, sources: ['original.ts'] }));
    writeFileSync(assetPath, 'original asset');
    const receiptPath = join(directory, 'receipt.json');
    writeFileSync(
      receiptPath,
      JSON.stringify({
        platform: 'ios',
        bundleSha256: 'a'.repeat(64),
        runtimeVersion: 'b'.repeat(40),
        commitHash: 'c'.repeat(40),
        branch: 'production',
        fileHashes: hashSourceMapExport(exportDir),
      }),
    );
    if (tamper === 'map')
      writeFileSync(mapPath, JSON.stringify({ ...JSON.parse(readFileSync(mapPath, 'utf8')), sources: ['wrong.ts'] }));
    if (tamper === 'asset') writeFileSync(assetPath, 'altered asset');
    if (tamper === 'extra') writeFileSync(join(exportDir, 'extra.js'), 'extra executable');
    if (tamper === 'missing') rmSync(assetPath);
    await expect(retryArchivedOta(receiptPath)).rejects.toThrow('files differ');
    expect(uploadMobileSourceMaps).not.toHaveBeenCalled();
    expect(publishArchivedOta).not.toHaveBeenCalled();
  });
});
