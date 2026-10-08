// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('react', () => ({
  cache: <Arguments extends unknown[], Result>(callback: (...args: Arguments) => Result) => callback,
}));
vi.mock('@/app/lib/graphql/server-cached-client', () => ({ executeGraphQLInternal: execute }));
import { getPlaylistOgSummary, getProfileOgSummary, getSessionOgSummary, getSetterOgSummary } from '../dynamic-og-data';

beforeEach(() => {
  execute.mockReset();
});

describe('public previews reauthorize through the backend', () => {
  it('never fetches activity for a private profile', async () => {
    execute.mockResolvedValue({
      publicProfile: { displayName: 'Private climber', avatarUrl: '/avatar', isPrivate: true },
    });
    expect(await getProfileOgSummary('owner')).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('builds profile bars from only the ticks the anonymous backend returns', async () => {
    execute.mockResolvedValueOnce({ publicProfile: { displayName: 'Alex', avatarUrl: null, isPrivate: false } });
    execute.mockImplementation(async (_document: string, variables: { boardType: string }) => ({
      userTicks:
        variables.boardType === 'kilter'
          ? [
              { climbUuid: 'visible', difficulty: 15, status: 'send', climbedAt: '2026-01-01' },
              { climbUuid: 'visible', difficulty: 15, status: 'flash', climbedAt: '2026-01-02' },
              { climbUuid: 'attempt', difficulty: 16, status: 'attempt', climbedAt: '2026-01-03' },
            ]
          : [],
    }));
    const result = await getProfileOgSummary('owner');
    expect(result).toMatchObject({
      displayName: 'Alex',
      topBoardType: 'kilter',
      gradeRows: [{ difficulty: 15, cnt: 1 }],
    });
  });

  it('reauthorizes old profile URLs after a privacy change', async () => {
    execute.mockResolvedValue({ publicProfile: { displayName: 'Alex', avatarUrl: null, isPrivate: true } });
    expect(await getProfileOgSummary('owner')).toBeNull();
    expect(await getProfileOgSummary('owner')).toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('omits private sessions and playlists even when their IDs are known', async () => {
    execute.mockResolvedValueOnce({ sessionDetail: null });
    expect(await getSessionOgSummary('private-session')).toMatchObject({
      found: false,
      participantNames: [],
      totalSends: 0,
    });
    execute.mockResolvedValueOnce({ playlist: null });
    expect(await getPlaylistOgSummary('private-playlist')).toBeNull();
  });

  it('uses projected session participants and preserves allowed aggregate totals', async () => {
    execute.mockResolvedValue({
      sessionDetail: {
        sessionName: 'Crew',
        totalSends: 7,
        lastTickAt: '2026-01-01',
        boardTypes: ['kilter'],
        gradeDistribution: [{ grade: '5c/V2', flash: 2, send: 5 }],
        participants: [{ displayName: 'Alex' }, { displayName: null }],
      },
    });
    expect(await getSessionOgSummary('public-session')).toMatchObject({
      found: true,
      participantNames: ['Alex'],
      totalSends: 7,
      participantCount: 2,
      gradeRows: [{ difficulty: 15, count: 7 }],
    });
  });

  it('keeps a public live invite preview before its first tick, without private roster names', async () => {
    execute.mockResolvedValue({
      sessionDetail: null,
      session: {
        name: 'First session',
        startedAt: '2026-01-01',
        users: [
          { userId: null, username: 'Private climber', isLeader: true },
          { userId: 'public-user', username: 'Alex', isLeader: false },
        ],
      },
    });
    expect(await getSessionOgSummary('new-session')).toMatchObject({
      found: true,
      sessionName: 'First session',
      participantNames: ['Alex'],
      participantCount: 2,
      totalSends: 0,
      leaderName: null,
    });
  });

  it('does not reconstruct a private account link from a public setter name', async () => {
    execute.mockResolvedValue({
      setterProfile: { climbCount: 1, linkedUserDisplayName: null, linkedUserAvatarUrl: null },
    });
    expect(await getSetterOgSummary('catalog-setter')).toMatchObject({
      displayName: 'catalog-setter',
      avatarUrl: null,
    });
  });
});
