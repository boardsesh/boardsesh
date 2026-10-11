// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
const { execute, parseBoardRoute, boardDetails, renderBoard } = vi.hoisted(() => ({
  execute: vi.fn(),
  parseBoardRoute: vi.fn(),
  boardDetails: vi.fn(),
  renderBoard: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('react', () => ({
  cache: <Arguments extends unknown[], Result>(callback: (...args: Arguments) => Result) => callback,
}));
vi.mock('@/app/lib/graphql/server-cached-client', () => ({ executeGraphQLInternal: execute }));
vi.mock('@/app/lib/url-utils.server', () => ({ parseBoardRouteParamsWithSlugs: parseBoardRoute }));
vi.mock('@/app/lib/board-utils', () => ({ getBoardDetailsForBoard: boardDetails }));
vi.mock('@/app/components/board-renderer/util', () => ({ buildBoardRenderUrl: renderBoard }));
import { getPlaylistOgSummary, getProfileOgSummary, getSessionOgSummary, getSetterOgSummary } from '../dynamic-og-data';

beforeEach(() => {
  execute.mockReset();
  parseBoardRoute.mockReset();
  boardDetails.mockReset();
  renderBoard.mockReset();
  parseBoardRoute.mockResolvedValue({ board_name: 'tension', layout_id: 2, size_id: 3, set_ids: [4], angle: 35 });
  boardDetails.mockImplementation((params: { board_name: string }) => ({
    board_name: params.board_name,
    layout_name: `${params.board_name} Board Original`,
    size_name: '12 x 12 Commercial',
  }));
  renderBoard.mockReturnValue('/render/board?thumbnail=1');
});

describe('session preview current-board context', () => {
  const sessionDetail = {
    sessionName: 'Crew',
    totalSends: 2,
    lastTickAt: '2026-01-01',
    boardTypes: ['kilter'],
    gradeDistribution: [{ grade: '6c/V5', flash: 0, send: 2 }],
    participants: [],
  };
  const session = { name: 'Crew', startedAt: '2026-01-01', users: [] };

  it('resolves the current named board anonymously instead of reusing the prior board', async () => {
    execute.mockResolvedValueOnce({ sessionDetail, session: { ...session, boardPath: '/b/current-board/35/list' } });
    execute.mockResolvedValueOnce({
      boardBySlug: {
        boardType: 'tension',
        layoutId: 2,
        sizeId: 3,
        setIds: '4,5',
        angle: 40,
        isPublic: true,
      },
    });
    expect(await getSessionOgSummary('switched')).toMatchObject({
      boardType: 'tension',
      boardLabel: 'Tension Original 12x12',
      boardAngle: 35,
      boardPreviewPath: '/render/board?thumbnail=1',
      totalSends: 2,
      gradeRows: [{ difficulty: 20, count: 2 }],
    });
    expect(execute.mock.calls[0][0]).toContain('name boardPath startedAt');
    expect(execute.mock.calls[1][1]).toEqual({ slug: 'current-board' });
    expect(boardDetails).toHaveBeenCalledWith({
      board_name: 'tension',
      layout_id: 2,
      size_id: 3,
      set_ids: [4, 5],
      angle: 35,
    });
  });

  it('keeps masked current boards generic even when old ticks name a different board', async () => {
    execute.mockResolvedValueOnce({ sessionDetail, session: { ...session, boardPath: '/fr/b/private-board/40' } });
    execute.mockResolvedValueOnce({ boardBySlug: null });
    expect(await getSessionOgSummary('masked')).toMatchObject({
      boardType: null,
      boardLabel: null,
      boardAngle: null,
      boardPreviewPath: null,
      gradeRows: [{ difficulty: 20, count: 2 }],
    });
    expect(boardDetails).not.toHaveBeenCalled();
    expect(execute.mock.calls[1][1]).toEqual({ slug: 'private-board' });
  });

  it('refuses an explicitly private board response', async () => {
    execute.mockResolvedValueOnce({ sessionDetail, session: { ...session, boardPath: '/b/private-board' } });
    execute.mockResolvedValueOnce({
      boardBySlug: {
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 2,
        setIds: '3',
        angle: 40,
        isPublic: false,
      },
    });
    expect(await getSessionOgSummary('private')).toMatchObject({ boardType: null, boardPreviewPath: null });
    expect(renderBoard).not.toHaveBeenCalled();
  });

  it('parses localized numeric paths and preserves a zero-degree angle', async () => {
    execute.mockResolvedValueOnce({ sessionDetail, session: { ...session, boardPath: '/es/tension/2/3/4/0/list' } });
    expect(await getSessionOgSummary('numeric')).toMatchObject({ boardType: 'tension', boardAngle: 0 });
    expect(parseBoardRoute).toHaveBeenCalledWith({
      board_name: 'tension',
      layout_id: '2',
      size_id: '3',
      set_ids: '4',
      angle: '0',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('uses the catalogue resolver for localized readable paths', async () => {
    execute.mockResolvedValueOnce({
      sessionDetail,
      session: { ...session, boardPath: 'https://boardsesh.com/de/tension/original/8x10/main_aux/35/list' },
    });
    expect(await getSessionOgSummary('readable')).toMatchObject({ boardType: 'tension', boardAngle: 35 });
    expect(parseBoardRoute).toHaveBeenCalledWith({
      board_name: 'tension',
      layout_id: 'original',
      size_id: '8x10',
      set_ids: 'main_aux',
      angle: '35',
    });
  });

  it('preserves authorized sends when the current board cannot resolve', async () => {
    execute.mockResolvedValueOnce({ sessionDetail, session: { ...session, boardPath: '/invalid' } });
    expect(await getSessionOgSummary('invalid')).toMatchObject({
      boardType: null,
      boardLabel: null,
      boardPreviewPath: null,
      totalSends: 2,
    });
    expect(parseBoardRoute).not.toHaveBeenCalled();
  });
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
