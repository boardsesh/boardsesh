import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { candidateFixture } from './__tests__/helpers/ota-stable-fixtures';
import { promoteEarlyTrack } from './mobile-ota-promote-track';

const promote = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./mobile-ota-promote.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-ota-promote.ts')>()),
  promoteArchivedOta: promote,
}));
const tempPaths: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});
it('uses the saved beta baseline and preserves the original production receipt', async () => {
  const path = mkdtempSync(join(tmpdir(), 'ota-track-'));
  tempPaths.push(path);
  const early = { ios: null, android: '77777777-7777-7777-7777-777777777777' };
  const receipt = { ...candidateFixture().receipt, baselineEarlyUpdateIds: early };
  const original = JSON.stringify(receipt);
  writeFileSync(join(path, 'receipt.json'), original);
  await promoteEarlyTrack(path, 'https://updates.test/manifest', 'publish-token');
  expect(promote).toHaveBeenCalledWith(
    expect.objectContaining({
      branch: 'pr-beta',
      receiptPath: join(path, 'early-receipt.json'),
      iosExport: join(path, 'ios'),
      androidExport: join(path, 'android'),
    }),
  );
  expect(JSON.parse(readFileSync(join(path, 'early-receipt.json'), 'utf8')).baselineProductionUpdateIds).toEqual(early);
  expect(readFileSync(join(path, 'receipt.json'), 'utf8')).toBe(original);
});
it('refuses legacy receipts lacking the pre-stage beta baseline', async () => {
  const path = mkdtempSync(join(tmpdir(), 'ota-track-'));
  tempPaths.push(path);
  writeFileSync(join(path, 'receipt.json'), JSON.stringify(candidateFixture().receipt));
  await expect(promoteEarlyTrack(path, 'https://updates.test/manifest', 'publish-token')).rejects.toThrow();
  expect(promote).not.toHaveBeenCalled();
});
