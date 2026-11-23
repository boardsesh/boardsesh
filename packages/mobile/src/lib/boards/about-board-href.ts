/**
 * The board picker opened on one board's detail sheet: the Climbs menu's
 * About this board, and the notifications about a board. `relistGym` adds the
 * sheet's "Ask {{gym}} to list it again" for the creator whose board that
 * gym's staff took off.
 */
export function aboutBoardHref(boardUuid: string, options: { relistGym?: string | null } = {}) {
  return {
    pathname: '/boards' as const,
    params: {
      board: boardUuid,
      details: '1',
      ...(options.relistGym ? { relistGym: options.relistGym } : {}),
    },
  };
}

/** The board picker opened on one board's report review sheet. */
export function reviewBoardReportsHref(boardUuid: string) {
  return { pathname: '/boards' as const, params: { board: boardUuid, review: '1' } };
}
