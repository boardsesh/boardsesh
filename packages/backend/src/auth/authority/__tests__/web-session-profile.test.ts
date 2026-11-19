import { describe, expect, it } from 'vite-plus/test';
import { profileDisplayReader } from '../web-session';
import type { AuthorityDatabase } from '../adapter';

// #7596 B7: the session read's profile fields are cosmetic and come from the
// application connection. However that read fails, the session still answers,
// with the account's own name and image.
type Selecting = Pick<AuthorityDatabase, 'select'>;

/** A database whose one query resolves, rejects or never settles, as `query` says. */
function databaseAnswering(query: () => Promise<unknown>): Selecting {
  const chain = { from: () => chain, where: () => query() };
  return { select: () => chain } as unknown as Selecting;
}

describe('profileDisplayReader', () => {
  it('gives the profile row', async () => {
    const read = profileDisplayReader(databaseAnswering(async () => [{ displayName: 'Profile', avatarUrl: null }]));
    expect(await read('user')).toEqual({ displayName: 'Profile', avatarUrl: null });
  });

  it('gives nothing when there is no profile', async () => {
    expect(await profileDisplayReader(databaseAnswering(async () => []))('user')).toBeUndefined();
  });

  it('gives nothing when the read is refused, as a 42501 on a connection that may not read the table', async () => {
    const refused = Object.assign(new Error('permission denied for table user_profiles'), { code: '42501' });
    expect(await profileDisplayReader(databaseAnswering(() => Promise.reject(refused)))('user')).toBeUndefined();
  });

  it('gives nothing when building the query throws, as with no application connection at all', async () => {
    const unreachable = {
      select: () => {
        throw new Error('APPLICATION_DATABASE_UNREACHABLE');
      },
    } as unknown as Selecting;
    expect(await profileDisplayReader(unreachable)('user')).toBeUndefined();
  });

  it('gives nothing once the read takes longer than its deadline', async () => {
    const started = Date.now();
    const read = profileDisplayReader(
      databaseAnswering(() => new Promise(() => undefined)),
      50,
    );
    expect(await read('user')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
