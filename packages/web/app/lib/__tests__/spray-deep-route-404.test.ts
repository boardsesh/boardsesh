// `/spray/...` must 404 on www.
//
// A spray wall's layout and size are created at runtime for one climber's wall,
// so the deep `/[board_name]/[layout]/[size]/[sets]/[angle]` route names no
// board model; a wall is reached at `/b/{slug}` like any other user board, and
// SW-16 (#5449) decides whether www grows a public surface at all.
//
// `boardHasDeepConfigRoute` is unit-tested on its own; what this file pins is
// that the ROUTE PARSER actually calls `notFound()`, through both of its
// branches. The numeric branch matters most: a spray URL is all-numeric by
// construction (it has no slugs), and that branch never reaches
// `parseBoardRouteParamsWithSlugs` — so a guard placed only there would have
// been dead code on the exact path spray takes.

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const notFound = vi.fn(() => {
  throw new Error('NOT_FOUND');
});

vi.mock('server-only', () => ({}));
// url-utils.server reaches slug-utils, which builds the pool at module scope.
// The parser 404s before any query, so an inert stub is enough.
vi.mock('@/app/lib/db/db', () => ({ sql: {}, dbz: {}, dbzRead: {} }));
vi.mock('next/navigation', () => ({ notFound, permanentRedirect: vi.fn() }));

const { parseRouteParams, parseBoardRouteParamsWithSlugs } = await import('../url-utils.server');

const CLIMB_UUID = 'abcdef1234567890abcdef1234567890';

/** `/spray/900/900/1/40/list` — the all-numeric form spray would ever emit. */
const NUMERIC_SPRAY_PARAMS = {
  board_name: 'spray',
  layout_id: '900',
  size_id: '900',
  set_ids: '1',
  angle: '40',
};

/** The same wall addressed with slug-shaped segments nothing ever built. */
const SLUG_SPRAY_PARAMS = {
  board_name: 'spray',
  layout_id: 'my-garage-wall',
  size_id: 'my-garage-wall',
  set_ids: 'holds',
  angle: '40',
};

beforeEach(() => {
  notFound.mockClear();
});

describe('the spray deep route', () => {
  it('404s on the all-numeric list path', async () => {
    await expect(parseRouteParams(NUMERIC_SPRAY_PARAMS)).rejects.toThrow('NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('404s on the all-numeric climb-view path', async () => {
    await expect(parseRouteParams({ ...NUMERIC_SPRAY_PARAMS, climb_uuid: CLIMB_UUID })).rejects.toThrow('NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('404s on a slug-shaped path through the slug parser', async () => {
    await expect(parseBoardRouteParamsWithSlugs(SLUG_SPRAY_PARAMS)).rejects.toThrow('NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('does not 404 a real catalogue board on the same numeric path', async () => {
    // Guards the guard: a parser that 404'd everything would pass the three
    // cases above for the wrong reason.
    const parsed = await parseRouteParams({
      board_name: 'kilter',
      layout_id: '1',
      size_id: '10',
      set_ids: '1,20',
      angle: '40',
    });
    expect(notFound).not.toHaveBeenCalled();
    expect(parsed.parsedParams.board_name).toBe('kilter');
  });
});
