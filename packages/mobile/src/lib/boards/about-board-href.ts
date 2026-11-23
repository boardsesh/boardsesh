/**
 * The board picker opened on one board's detail sheet: the Climbs menu's
 * About this board, and the notifications about a board. `relistGym` adds the
 * sheet's "Ask {{gym}} to list it again" for the creator whose board that
 * gym's staff took off: the gym's uuid, which the sheet loads the gym by, and
 * the notice's name for it until it has.
 */
export function aboutBoardHref(
  boardUuid: string,
  options: { relistGym?: { uuid: string; name: string | null } | null } = {},
) {
  const relistGym = options.relistGym ?? null;
  return {
    pathname: '/boards' as const,
    params: {
      board: boardUuid,
      details: '1',
      ...(relistGym ? { relistGymUuid: relistGym.uuid } : {}),
      ...(relistGym?.name ? { relistGym: relistGym.name } : {}),
    },
  };
}

/** The board picker opened on one board's report review sheet. */
export function reviewBoardReportsHref(boardUuid: string) {
  return { pathname: '/boards' as const, params: { board: boardUuid, review: '1' } };
}
