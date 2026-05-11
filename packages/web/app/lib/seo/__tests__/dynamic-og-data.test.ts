// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const executeMock = vi.fn();
const buildBoardRenderUrlMock = vi.fn();
const resolveBoardBySlugMock = vi.fn();
const boardToRouteParamsMock = vi.fn();
const getBoardDetailsForBoardMock = vi.fn();
const parseBoardRouteParamsWithSlugsMock = vi.fn();

vi.mock('server-only', () => ({}));

vi.mock('@/app/components/board-renderer/util', () => ({
  buildBoardRenderUrl: buildBoardRenderUrlMock,
}));

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug: resolveBoardBySlugMock,
  boardToRouteParams: boardToRouteParamsMock,
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: getBoardDetailsForBoardMock,
}));

// dynamic-og-data uses `dbzRead` (drizzle) and `getReadPool()` (postgres-js
// tagged template) for replica-tolerant reads. Mock both onto the existing
// `executeMock` and a fresh tagged-template fake.
const mockSqlTag = vi.fn();
const rowsFromResultMock = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  throw new TypeError('Expected postgres-js query result to be a row array');
};
vi.mock('@/app/lib/db/db', () => ({
  dbz: { execute: executeMock },
  sql: mockSqlTag,
  dbzRead: { execute: executeMock },
  getReadPool: () => mockSqlTag,
  rowsFromResult: rowsFromResultMock,
  executeRows: async <T>(conn: { execute: (query: unknown) => Promise<unknown> }, query: unknown) =>
    rowsFromResultMock<T>(await conn.execute(query)),
}));

vi.mock('@/app/lib/string-utils', () => ({
  formatBoardDisplayName: vi.fn((value: string) =>
    value === 'moonboard' ? 'MoonBoard' : value.charAt(0).toUpperCase() + value.slice(1),
  ),
}));

vi.mock('@/app/lib/url-utils.server', () => ({
  parseBoardRouteParamsWithSlugs: parseBoardRouteParamsWithSlugsMock,
}));

describe('getSessionOgSummary', () => {
  beforeEach(() => {
    executeMock.mockReset();
    buildBoardRenderUrlMock.mockReset();
    resolveBoardBySlugMock.mockReset();
    boardToRouteParamsMock.mockReset();
    getBoardDetailsForBoardMock.mockReset();
    parseBoardRouteParamsWithSlugsMock.mockReset();

    buildBoardRenderUrlMock.mockReturnValue('/api/internal/board-render?frames=&thumbnail=1');
    boardToRouteParamsMock.mockReturnValue({
      board_name: 'kilter',
      layout_id: 1,
      size_id: 7,
      set_ids: [1, 20],
      angle: 40,
    });
    getBoardDetailsForBoardMock.mockReturnValue({
      board_name: 'kilter',
      layout_id: 1,
      size_id: 7,
      set_ids: [1, 20],
      layout_name: 'Kilter Board Original',
      size_name: '12 x 12 Commercial',
      size_description: 'Commercial',
    });
    parseBoardRouteParamsWithSlugsMock.mockResolvedValue({
      board_name: 'tension',
      layout_id: 2,
      size_id: 3,
      set_ids: [4],
      angle: 0,
    });
    vi.resetModules();
  });

  it('reads party sessions from board_sessions and resolves slug board previews', async () => {
    executeMock
      .mockResolvedValueOnce([
        {
          name: 'Evening Session',
          leader_name: 'Alex',
          version_at: '2024-01-03T00:00:00.000Z',
          board_path: '/b/my-home-wall',
          board_slug: null,
          board_angle: null,
          board_type: null,
          layout_id: null,
          size_id: null,
          set_ids: null,
        },
      ])
      .mockResolvedValueOnce([{ participant_count: 2 }])
      .mockResolvedValueOnce([{ display_name: 'Alex' }, { display_name: 'Sam' }])
      .mockResolvedValueOnce([{ total_sends: 2 }])
      .mockResolvedValueOnce([{ difficulty: 10, cnt: 2 }]);
    resolveBoardBySlugMock.mockResolvedValue({
      slug: 'my-home-wall',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 7,
      setIds: '1,20',
      angle: 40,
    });

    const { getSessionOgSummary } = await import('../dynamic-og-data');
    const summary = await getSessionOgSummary('session-123');

    const sessionQuery = executeMock.mock.calls[0][0] as {
      queryChunks?: Array<{ value?: string[] }>;
    };
    const sqlText = (sessionQuery.queryChunks || [])
      .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join('') : ''))
      .join('');

    expect(sqlText).toContain('bs.name');
    expect(sqlText).toContain('FROM board_sessions bs');
    const gradeQuery = executeMock.mock.calls[4][0] as {
      queryChunks?: Array<{ value?: string[] }>;
    };
    const gradeSql = (gradeQuery.queryChunks || [])
      .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join('') : ''))
      .join('');

    expect(executeMock).toHaveBeenCalledTimes(5);
    expect(gradeSql).toContain('display_difficulty');
    expect(resolveBoardBySlugMock).toHaveBeenCalledWith('my-home-wall');
    expect(boardToRouteParamsMock).toHaveBeenCalled();
    expect(buildBoardRenderUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ board_name: 'kilter' }),
      '',
      expect.objectContaining({ thumbnail: true, includeBackground: true, format: 'png' }),
    );
    expect(summary.sessionType).toBe('party');
    expect(summary.sessionName).toBe('Evening Session');
    expect(summary.leaderName).toBe('Alex');
    expect(summary.participantNames).toEqual(['Alex', 'Sam']);
    expect(summary.participantCount).toBe(2);
    expect(summary.totalSends).toBe(2);
    expect(summary.boardLabel).toBe('Kilter Original 12x12');
    expect(summary.boardAngle).toBe(40);
    expect(summary.boardPreviewPath).toBe('/api/internal/board-render?frames=&thumbnail=1');
    expect(summary.found).toBe(true);
  });

  it('parses legacy board paths and falls back to inferred sessions cleanly', async () => {
    executeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          name: 'Solo Volume Day',
          leader_name: 'Alex',
          version_at: '2024-01-05T00:00:00.000Z',
          board_path: null,
          board_slug: null,
          board_angle: null,
          board_type: null,
          layout_id: null,
          size_id: null,
          set_ids: null,
        },
      ])
      .mockResolvedValueOnce([{ participant_count: 1 }])
      .mockResolvedValueOnce([{ display_name: 'Alex' }])
      .mockResolvedValueOnce([{ total_sends: 1 }])
      .mockResolvedValueOnce([{ difficulty: 12, cnt: 1 }]);

    const { getSessionOgSummary } = await import('../dynamic-og-data');
    const summary = await getSessionOgSummary('inferred-123');

    const inferredQuery = executeMock.mock.calls[1][0] as {
      queryChunks?: Array<{ value?: string[] }>;
    };
    const inferredSql = (inferredQuery.queryChunks || [])
      .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join('') : ''))
      .join('');

    expect(inferredSql).toContain('FROM inferred_sessions s');
    expect(executeMock).toHaveBeenCalledTimes(6);
    expect(summary.sessionType).toBe('inferred');
    expect(summary.sessionName).toBe('Solo Volume Day');
    expect(summary.leaderName).toBe('Alex');
    expect(summary.participantNames).toEqual(['Alex']);
    expect(summary.participantCount).toBe(1);
    expect(summary.totalSends).toBe(1);
    expect(summary.boardLabel).toBeNull();
    expect(summary.boardPreviewPath).toBeNull();
    expect(summary.found).toBe(true);
  });

  it('uses board config from legacy board paths when present', async () => {
    executeMock
      .mockResolvedValueOnce([
        {
          name: 'Board Night',
          leader_name: 'Sam',
          version_at: '2024-01-06T00:00:00.000Z',
          board_path: '/tension/original/8x10/main_aux/35',
          board_slug: null,
          board_angle: null,
          board_type: null,
          layout_id: null,
          size_id: null,
          set_ids: null,
        },
      ])
      .mockResolvedValueOnce([{ participant_count: 3 }])
      .mockResolvedValueOnce([{ display_name: 'Sam' }, { display_name: 'Taylor' }])
      .mockResolvedValueOnce([{ total_sends: 3 }])
      .mockResolvedValueOnce([{ difficulty: 10, cnt: 3 }]);
    parseBoardRouteParamsWithSlugsMock.mockResolvedValueOnce({
      board_name: 'tension',
      layout_id: 2,
      size_id: 3,
      set_ids: [4, 5],
      angle: 35,
    });
    getBoardDetailsForBoardMock.mockReturnValueOnce({
      board_name: 'tension',
      layout_id: 2,
      size_id: 3,
      set_ids: [4, 5],
      layout_name: 'Tension Board Original',
      size_name: '8 x 10',
      size_description: 'Home',
    });

    const { getSessionOgSummary } = await import('../dynamic-og-data');
    const summary = await getSessionOgSummary('legacy-party-123');

    expect(parseBoardRouteParamsWithSlugsMock).toHaveBeenCalledWith({
      board_name: 'tension',
      layout_id: 'original',
      size_id: '8x10',
      set_ids: 'main_aux',
      angle: '35',
    });
    expect(summary.boardLabel).toBe('Tension Original 8x10');
    expect(summary.boardAngle).toBe(35);
  });

  it('counts sends even when tick difficulty is null and grades come from climb stats', async () => {
    executeMock
      .mockResolvedValueOnce([
        {
          name: 'Null Grade Night',
          leader_name: 'Alex',
          version_at: '2024-01-07T00:00:00.000Z',
          board_path: '/b/my-home-wall',
          board_slug: null,
          board_angle: null,
          board_type: null,
          layout_id: null,
          size_id: null,
          set_ids: null,
        },
      ])
      .mockResolvedValueOnce([{ participant_count: 1 }])
      .mockResolvedValueOnce([{ display_name: 'Alex' }])
      .mockResolvedValueOnce([{ total_sends: 5 }])
      .mockResolvedValueOnce([{ difficulty: 20, cnt: 5 }]);
    resolveBoardBySlugMock.mockResolvedValue({
      slug: 'my-home-wall',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 7,
      setIds: '1,20',
      angle: 40,
    });

    const { getSessionOgSummary } = await import('../dynamic-og-data');
    const summary = await getSessionOgSummary('null-grade-session');

    expect(summary.totalSends).toBe(5);
    expect(summary.gradeRows).toEqual([{ difficulty: 20, count: 5 }]);
  });
});
