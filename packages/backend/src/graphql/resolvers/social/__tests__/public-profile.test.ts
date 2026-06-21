/**
 * Unit tests for the publicProfile resolver's instagramUrl passthrough.
 *
 * The resolver left-joins userProfiles and surfaces its instagramUrl on the
 * PublicUserProfile so the mobile profile header can render a climber's
 * Instagram link (mirroring the web profile). db + the enrichment helper are
 * mocked so the resolver never touches real infrastructure.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { limitMock, batchEnrichMock } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  batchEnrichMock: vi.fn(),
}));

vi.mock('../../../../db/client', () => ({
  db: {
    select: () => {
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(limitMock()),
      };
      return chain;
    },
  },
}));

vi.mock('../helpers', () => ({
  batchEnrichUserProfiles: (...args: unknown[]) => batchEnrichMock(...args),
}));

// publicProfile never publishes, but follows.ts imports the events module at
// load — stub it so importing the resolver needs no redis/pubsub.
vi.mock('../../../../events/index', () => ({
  publishSocialEvent: vi.fn(),
}));

import { socialFollowQueries } from '../follows';

const ctx = { isAuthenticated: true, userId: 'viewer-1' } as unknown as ConnectionContext;

describe('publicProfile resolver — instagramUrl', () => {
  beforeEach(() => {
    limitMock.mockReset();
    batchEnrichMock.mockReset();
    batchEnrichMock.mockResolvedValue(
      new Map([['user-1', { followerCount: 3, followingCount: 5, isFollowedByMe: true }]]),
    );
  });

  it('surfaces the instagramUrl from the joined user profile', async () => {
    limitMock.mockResolvedValue([
      {
        id: 'user-1',
        name: 'Alex',
        image: null,
        displayName: 'Alex Honnold',
        avatarUrl: 'https://cdn.example.com/avatar.png',
        instagramUrl: 'https://instagram.com/alex',
      },
    ]);

    const result = await socialFollowQueries.publicProfile({}, { userId: 'user-1' }, ctx);

    expect(result).toMatchObject({
      id: 'user-1',
      displayName: 'Alex Honnold',
      instagramUrl: 'https://instagram.com/alex',
      followerCount: 3,
      followingCount: 5,
      isFollowedByMe: true,
    });
  });

  it('returns null instagramUrl when the user has not set one', async () => {
    limitMock.mockResolvedValue([
      { id: 'user-1', name: 'Alex', image: null, displayName: null, avatarUrl: null, instagramUrl: null },
    ]);

    const result = await socialFollowQueries.publicProfile({}, { userId: 'user-1' }, ctx);

    expect(result?.instagramUrl).toBeNull();
  });

  it('returns null for a user that does not exist', async () => {
    limitMock.mockResolvedValue([]);

    const result = await socialFollowQueries.publicProfile({}, { userId: 'missing' }, ctx);

    expect(result).toBeNull();
  });
});
