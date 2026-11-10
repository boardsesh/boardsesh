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

  it("reads the card's own documents: stats with consensus grades and the hardest visible send", async () => {
    execute.mockResolvedValueOnce({ publicProfile: { displayName: 'Alex', avatarUrl: null, isPrivate: false } });
    execute.mockResolvedValueOnce({
      userProfileStats: {
        totalDistinctClimbs: 14,
        layoutStats: [
          { boardType: 'tension', distinctClimbCount: 2, gradeCounts: [] },
          { boardType: 'kilter', distinctClimbCount: 12, gradeCounts: [{ grade: '24', count: 1 }] },
          { boardType: 'moonboard', distinctClimbCount: 0, gradeCounts: [] },
        ],
      },
      userAscentsFeed: {
        items: [
          { climbUuid: 'c1', climbName: 'Swooped', boardType: 'kilter', difficulty: null, consensusDifficulty: 23.6 },
        ],
      },
    });

    const result = await getProfileOgSummary('owner');

    expect(result).toMatchObject({
      displayName: 'Alex',
      topBoardType: 'kilter',
      sentBoardTypes: ['kilter', 'tension'],
      sentClimbCount: 14,
      // No logged grade, so the consensus (rounded to 24) stands in.
      hardestSend: { climbName: 'Swooped', grade: '7b/V8' },
    });
    const [, [document, variables]] = execute.mock.calls;
    expect(String(document)).toContain('userProfileStats');
    expect(variables).toMatchObject({
      input: { limit: 1, sortBy: 'hardest', statusMode: 'send', excludeHiddenClimbs: true },
    });
  });

  it('leaves the name to the page when the climber has none, instead of inventing one', async () => {
    execute.mockResolvedValueOnce({ publicProfile: { displayName: '  ', avatarUrl: null, isPrivate: false } });
    execute.mockResolvedValueOnce({
      userProfileStats: { totalDistinctClimbs: 0, layoutStats: [] },
      userAscentsFeed: { items: [] },
    });

    expect(await getProfileOgSummary('owner')).toMatchObject({
      displayName: null,
      hardestSend: null,
      topBoardType: null,
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
      setterProfile: { climbCount: 1, totalAscents: 4, linkedUserDisplayName: null, linkedUserAvatarUrl: null },
    });
    expect(await getSetterOgSummary('catalog-setter')).toMatchObject({
      displayName: 'catalog-setter',
      totalAscents: 4,
    });
  });

  it("versions a setter's card on what it draws, not a constant", async () => {
    execute.mockResolvedValueOnce({
      setterProfile: {
        climbCount: 391,
        totalAscents: 1_136_595,
        linkedUserDisplayName: null,
        linkedUserAvatarUrl: null,
      },
    });
    execute.mockResolvedValueOnce({
      setterProfile: {
        climbCount: 391,
        totalAscents: 1_136_600,
        linkedUserDisplayName: null,
        linkedUserAvatarUrl: null,
      },
    });

    const before = await getSetterOgSummary('KilterStudio');
    const after = await getSetterOgSummary('KilterStudio');

    expect(before?.version).not.toBe(after?.version);
  });

  it('picks the hardest send and the hardest attempt from the ticks a stranger may see', async () => {
    execute.mockResolvedValue({
      sessionDetail: {
        sessionName: null,
        totalSends: 2,
        totalFlashes: 1,
        durationMinutes: 49,
        lastTickAt: '2026-01-01',
        boardTypes: ['kilter'],
        gradeDistribution: [],
        participants: [{ displayName: 'Zara' }],
        ticks: [
          {
            boardType: 'kilter',
            angle: 40,
            status: 'flash',
            difficulty: 16,
            difficultyName: '6a/V3',
          },
          {
            boardType: 'kilter',
            angle: 45,
            status: 'send',
            difficulty: 22,
            difficultyName: '7a/V6',
          },
          {
            boardType: 'kilter',
            angle: 45,
            status: 'attempt',
            difficulty: 25,
            difficultyName: null,
          },
        ],
      },
      session: null,
    });

    expect(await getSessionOgSummary('recap')).toMatchObject({
      isLive: false,
      tickCount: 3,
      totalFlashes: 1,
      durationMinutes: 49,
      recapParticipants: [{ name: 'Zara' }],
      hardestSend: { grade: '7a/V6', angle: 45, flashed: false },
      hardestAttempt: { grade: '7b+/V8', angle: 45, flashed: false },
    });
  });

  it("reads a live session's named board through boardBySlug, keeping the path's angle", async () => {
    execute.mockResolvedValueOnce({
      sessionDetail: null,
      session: {
        name: null,
        startedAt: '2026-01-01',
        boardPath: '/b/boiler-room-moonboard/25/list',
        users: [{ userId: 'u1', username: 'Huy Dang', isLeader: true }],
      },
    });
    execute.mockResolvedValueOnce({ boardBySlug: { boardType: 'moonboard', angle: 40 } });

    expect(await getSessionOgSummary('live')).toMatchObject({
      isLive: true,
      inviteName: 'Huy Dang',
      liveBoard: { boardType: 'moonboard', angle: 25 },
    });
    expect(execute.mock.calls[1][1]).toEqual({ slug: 'boiler-room-moonboard' });
  });

  it('never asks the anonymous surface for climb names, since it cannot say which are hidden', async () => {
    execute.mockResolvedValue({ sessionDetail: null, session: null });

    await getSessionOgSummary('any');

    expect(String(execute.mock.calls[0][0])).not.toContain('climbName');
  });

  it('keeps a live session found when its board lookup fails, and drops only the board', async () => {
    execute.mockResolvedValueOnce({
      sessionDetail: null,
      session: { name: null, startedAt: '2026-01-01', boardPath: '/b/some-wall', users: [] },
    });
    execute.mockRejectedValueOnce(new Error('boardBySlug failed'));

    expect(await getSessionOgSummary('live-flaky')).toMatchObject({ found: true, isLive: true, liveBoard: null });
  });

  it("reads a live session's geometry path without a lookup", async () => {
    execute.mockResolvedValue({
      sessionDetail: null,
      session: { name: null, startedAt: '2026-01-01', boardPath: 'tension/9/1/8,9/40', users: [] },
    });

    expect(await getSessionOgSummary('geometry')).toMatchObject({
      inviteName: null,
      liveBoard: { boardType: 'tension', angle: 40 },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("counts a public playlist's climbs as a stranger sees them, and folds the band into the token", async () => {
    execute.mockResolvedValueOnce({
      playlist: {
        name: 'Benchmarks',
        description: null,
        color: null,
        icon: null,
        isPublic: true,
        boardType: 'kilter',
        climbCount: 120,
        updatedAt: '2026-01-01',
        gradeSummary: { p10Difficulty: 20, p90Difficulty: 26 },
      },
    });
    execute.mockResolvedValueOnce({ playlistClimbs: { totalCount: 117 } });

    const result = await getPlaylistOgSummary('pl-1');

    expect(result).toMatchObject({ climbCount: 117, gradeSummary: { p10Difficulty: 20, p90Difficulty: 26 } });
    expect(execute.mock.calls[1][1]).toEqual({ input: { playlistId: 'pl-1', page: 0, pageSize: 1 } });
  });

  it("never reads a private playlist's climbs", async () => {
    execute.mockResolvedValueOnce({
      playlist: {
        name: 'Mine',
        description: null,
        color: null,
        icon: null,
        isPublic: false,
        boardType: 'kilter',
        climbCount: 3,
        updatedAt: '2026-01-01',
        gradeSummary: null,
      },
    });

    expect(await getPlaylistOgSummary('pl-private')).toMatchObject({ isPublic: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
