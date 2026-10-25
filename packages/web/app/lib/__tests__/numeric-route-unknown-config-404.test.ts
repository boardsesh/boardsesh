// An all-numeric deep route naming a board configuration the static catalogue
// does not carry must 404. The numeric branch of `parseRouteParams` used to
// check only for NaN, so `/woods/1/99/1/40/list` reached
// `getBoardDetailsForBoard` in a layout, threw, and returned a 500.

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const notFound = vi.fn(() => {
  throw new Error('NOT_FOUND');
});

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ sql: {}, dbz: {}, dbzRead: {} }));
vi.mock('next/navigation', () => ({ notFound, permanentRedirect: vi.fn() }));

const { parseRouteParams } = await import('../url-utils.server');

const CLIMB_UUID = 'abcdef1234567890abcdef1234567890';

beforeEach(() => {
  notFound.mockClear();
});

describe('numeric deep route with an unknown configuration', () => {
  it.each([
    ['woods unknown size', { board_name: 'woods', layout_id: '1', size_id: '99', set_ids: '1', angle: '40' }],
    ['woods unknown layout', { board_name: 'woods', layout_id: '7', size_id: '1', set_ids: '1', angle: '40' }],
    ['kilter unknown size', { board_name: 'kilter', layout_id: '1', size_id: '99', set_ids: '1,20', angle: '40' }],
    ['kilter unknown set', { board_name: 'kilter', layout_id: '1', size_id: '10', set_ids: '999', angle: '40' }],
    [
      'moonboard unknown layout',
      { board_name: 'moonboard', layout_id: '999', size_id: '1', set_ids: '1', angle: '40' },
    ],
    [
      'woods unknown size with a climb',
      { board_name: 'woods', layout_id: '1', size_id: '99', set_ids: '1', angle: '40', climb_uuid: CLIMB_UUID },
    ],
  ])('404s: %s', async (_label, params) => {
    await expect(parseRouteParams(params)).rejects.toThrow('NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it.each([
    ['kilter', { board_name: 'kilter', layout_id: '1', size_id: '10', set_ids: '1,20', angle: '40' }],
    ['woods', { board_name: 'woods', layout_id: '1', size_id: '2', set_ids: '1', angle: '40' }],
  ])('still resolves a real %s configuration as numeric', async (_label, params) => {
    const result = await parseRouteParams(params);
    expect(result.isNumericFormat).toBe(true);
    expect(notFound).not.toHaveBeenCalled();
  });
});
