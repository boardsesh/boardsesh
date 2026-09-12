// `useNewConnection: true` is the entire escape from the poisoned cache (#5410), and
// it is one word in one call. Without it the re-open is served the SAME dead
// instance — nothing closed it, so its refcount never reached zero and
// `removeCachedDatabase` never evicted it — and the whole recovery path silently
// republishes a dead handle as ready.
//
// The recovery tests in connection.test.ts inject a mock opener, so they never
// exercise this call. This suite is the only thing standing between that flag and a
// tidy-up.
import { describe, it, expect, vi } from 'vitest';

const openDatabaseAsyncMock = vi.hoisted(() =>
  vi.fn(async (_name: string, _options?: { useNewConnection?: boolean }) => ({ marker: 'replacement' })),
);
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: openDatabaseAsyncMock }));

import { openReplacementDatabase } from '../reopen';
import { DATABASE_NAME } from '../database-name';

describe('openReplacementDatabase', () => {
  it('bypasses the connection cache', async () => {
    await openReplacementDatabase();
    expect(openDatabaseAsyncMock).toHaveBeenCalledWith(DATABASE_NAME, { useNewConnection: true });
  });

  it('opens the app database, not some other file', async () => {
    await openReplacementDatabase();
    expect(openDatabaseAsyncMock).toHaveBeenCalledWith(DATABASE_NAME, expect.anything());
  });
});
