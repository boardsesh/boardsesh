import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Runtime } from '../runtime';
import { LocalStore } from '../storage';
import { withProfileLock } from '../profile-lock';
import { writeCredentials } from '../credentials';
import { searchLogbook } from '../history';
import { syncLogbook } from '../sync';
import { ISSUER, type Profile } from '../types';

it('serves offline history while the writer lock is held by a stalled network operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-reader-'));
  const profile: Profile = {
    issuer: ISSUER,
    clientId: 'public-client',
    subject: 'usr_one',
    accountId: 'one',
    generation: randomUUID(),
    authStatus: 'connected',
    scopes: ['logbook:read'],
  };
  let releaseWriter: () => void = () => {};
  let writer: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await withProfileLock(directory, async (guard) => {
      const store = new LocalStore(directory, () => guard.assertHeld());
      try {
        store.setProfile(profile);
        await writeCredentials(
          directory,
          {
            version: 1,
            issuer: ISSUER,
            clientId: profile.clientId,
            accountId: profile.accountId,
            generation: profile.generation,
            accessToken: 'access',
            refreshToken: 'refresh',
            refreshPending: false,
          },
          guard,
        );
        await syncLogbook(
          store,
          { request: async () => ({ changes: [], cursor: 'finished', hasMore: false }) },
          profile,
        );
      } finally {
        store.close();
      }
    });
    let enteredWriter: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredWriter = resolve;
    });
    const stalledNetwork = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    writer = withProfileLock(directory, async () => {
      enteredWriter();
      await stalledNetwork;
    });
    await entered;
    const runtime = new Runtime(directory);
    const history = await Promise.race([
      runtime.withCachedProfile('logbook:read', (store, current) => searchLogbook(store, current, {})),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Cached read waited for network writer')),
          process.platform === 'win32' ? 15_000 : 2000,
        );
      }),
    ]);
    expect(history.complete).toBe(true);
    expect(history.ticks).toEqual([]);
    expect((await runtime.status()).connected).toBe(true);
  } finally {
    clearTimeout(timeout);
    releaseWriter();
    await writer;
    await rm(directory, { recursive: true, force: true });
  }
});
