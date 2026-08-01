import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUserSync, fakeDb } = vi.hoisted(() => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    transaction: <Result>(processor: (transaction: unknown) => Promise<Result>) => processor(db),
    execute: () => Promise.resolve([]),
  };
  return { mockUserSync: vi.fn(), fakeDb: db };
});

vi.mock('../api/user-sync-api', () => ({ userSync: mockUserSync }));
vi.mock('drizzle-orm/postgres-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm/postgres-js')>();
  return { ...actual, drizzle: () => fakeDb };
});

import { syncUserData } from './user-sync';

describe('syncUserData diagnostic logging', () => {
  beforeEach(() => {
    mockUserSync.mockReset();
  });

  it('forwards logError to the table writer without failing the otherwise successful cycle', async () => {
    mockUserSync.mockResolvedValue({
      circuits: [{ name: 'missing UUID' }],
      user_syncs: [],
      _complete: true,
    });
    const errorMessages: string[] = [];

    await expect(
      syncUserData(
        {} as never,
        'tension',
        'token',
        144574,
        'user-1',
        ['circuits'],
        () => {},
        (message) => errorMessages.push(message),
      ),
    ).resolves.toMatchObject({ circuits: { synced: 0, skipped: 1 } });

    expect(errorMessages).toHaveLength(1);
    expect(JSON.parse(errorMessages[0] ?? '{}')).toMatchObject({
      event: 'aurora_circuit_playlist_malformed_payload',
      rejectedCount: 1,
    });
  });
});
