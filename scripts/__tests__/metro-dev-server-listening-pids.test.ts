import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}));

import { listeningPids } from '../lib/metro-dev-server';

beforeEach(() => spawnSyncMock.mockReset());

describe('listeningPids', () => {
  it('falls back to ss when lsof is missing', () => {
    spawnSyncMock.mockImplementation((command: string) =>
      command === 'lsof'
        ? { error: Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }), stdout: null }
        : { error: undefined, stdout: 'LISTEN 0 511 *:8097 *:* users:(("node",pid=1234,fd=23))\n' },
    );
    expect(listeningPids(8097)).toEqual([1234]);
  });

  it('uses lsof output when lsof exists', () => {
    spawnSyncMock.mockReturnValue({ error: undefined, stdout: '42\n43\n' });
    expect(listeningPids(8097)).toEqual([42, 43]);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('returns nothing when neither tool exists', () => {
    spawnSyncMock.mockReturnValue({ error: new Error('ENOENT'), stdout: null });
    expect(listeningPids(8097)).toEqual([]);
  });
});
