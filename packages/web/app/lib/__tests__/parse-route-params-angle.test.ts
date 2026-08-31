import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// `parseBoardAngleSegment` is unit-tested on its own in board-config, but the
// behaviour that matters to the URL surface is what the ROUTE PARSER does with
// it: a malformed or unsupported angle has to 404 rather than be coerced into a
// neighbouring valid angle and rendered. Coercion is what would quietly
// resurrect the duplicate climb URLs this change exists to consolidate.
//
// Deliberately exercises the real `parseRouteParams`. The page-level redirect
// suites all mock `@/app/lib/url-utils.server` wholesale, so the 404 decision
// is structurally untestable there — a test written against those mocks would
// assert the mock, not the parser.
const notFound = vi.fn(() => {
  throw new Error('NOT_FOUND');
});

vi.mock('server-only', () => ({}));
// `url-utils.server` reaches slug-utils, which constructs the pool at module
// scope. The parser under test never issues a query, so an inert stub is enough.
vi.mock('@/app/lib/db/db', () => ({ sql: {}, dbz: {}, dbzRead: {} }));
vi.mock('next/navigation', () => ({ notFound, permanentRedirect: vi.fn() }));

const { parseRouteParams } = await import('../url-utils.server');

const CLIMB_UUID = 'abcdef1234567890abcdef1234567890';

function params(boardName: string, angle: string) {
  return {
    board_name: boardName,
    layout_id: '1',
    size_id: '10',
    set_ids: '1,20',
    angle,
    climb_uuid: CLIMB_UUID,
  };
}

beforeEach(() => {
  notFound.mockClear();
});

describe('parseRouteParams angle validation', () => {
  const rejected: [string, string, string][] = [
    ['kilter', '-5', 'Kilter has no -5 degree setting; only Grasshopper does'],
    ['kilter', '91', 'past the top of every board range'],
    ['kilter', '040', 'a numeric alias of 40, not its canonical spelling'],
    ['kilter', '40.0', 'a decimal alias of 40'],
    ['kilter', '+40', 'a signed alias of 40'],
    ['kilter', 'forty', 'not a number at all'],
  ];

  for (const [board, angle, why] of rejected) {
    it(`404s on ${board} angle "${angle}" — ${why}`, async () => {
      await expect(parseRouteParams(params(board, angle))).rejects.toThrow('NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
    });
  }

  it('accepts a canonically spelled angle that is not a picker step', async () => {
    // 41 is not a 5-degree picker option, but stored boards and climbs carry
    // arbitrary integers and those URLs must keep resolving.
    const { parsedParams } = await parseRouteParams(params('kilter', '41'));
    expect(parsedParams.angle).toBe(41);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('accepts the real Grasshopper -5 degree setting', async () => {
    const { parsedParams } = await parseRouteParams(params('grasshopper', '-5'));
    expect(parsedParams.angle).toBe(-5);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('404s on an unknown board before it ever looks at the angle', async () => {
    await expect(parseRouteParams(params('notaboard', '40'))).rejects.toThrow('NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });
});
