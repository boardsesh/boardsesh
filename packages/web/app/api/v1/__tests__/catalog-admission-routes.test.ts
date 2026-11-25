// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextResponse } from 'next/server';

const { admission, parseParams, getClimb, getSetters, recordRows } = vi.hoisted(() => ({
  admission: vi.fn(),
  parseParams: vi.fn(),
  getClimb: vi.fn(),
  getSetters: vi.fn(),
  recordRows: vi.fn(),
}));
vi.mock('@/app/lib/api/catalog-admission.server', () => ({ withCatalogAdmission: admission }));
vi.mock('@/app/lib/data/queries', () => ({ getClimb }));
vi.mock('@boardsesh/db/queries', () => ({ getSetterStats: getSetters }));
vi.mock('@/app/lib/db/db', () => ({ dbzRead: {} }));
vi.mock('@/app/lib/url-utils.server', () => ({ parseBoardRouteParamsWithSlugs: parseParams }));
vi.mock('@/app/components/board-renderer/util', () => ({ convertLitUpHoldsStringToMap: () => [{}] }));

import { GET as detail } from '../[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/[climb_uuid]/route';
import { GET as setters } from '../[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/setters/route';

const params = {
  board_name: 'kilter',
  layout_id: 'layout-slug',
  size_id: 'size-slug',
  set_ids: 'sets-slug',
  angle: '40',
  climb_uuid: 'climb-id',
};
const request = new Request('https://www.boardsesh.com/api/v1/kilter/layout-slug/size-slug/sets-slug/40/climb-id');

describe('legacy catalog routes hold backend admission around all reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admission.mockImplementation((_request, _operation, work) => work(recordRows));
    parseParams.mockResolvedValue({ board_name: 'kilter' });
    getClimb.mockResolvedValue({ uuid: 'climb-id', frames: '', catalogAngle: 40 });
    getSetters.mockResolvedValue([{ setter_username: 'Example' }]);
  });

  it.each([
    ['restclimb', detail],
    ['restsetters', setters],
  ] as const)('%s does not resolve slugs or query the catalog before admission', async (operation, handler) => {
    admission.mockResolvedValue(NextResponse.json({ error: 'Rate limited' }, { status: 429 }));
    expect((await handler(request, { params: Promise.resolve(params) })).status).toBe(429);
    expect(admission).toHaveBeenCalledWith(request, operation, expect.any(Function));
    expect(parseParams).not.toHaveBeenCalled();
    expect(getClimb).not.toHaveBeenCalled();
    expect(getSetters).not.toHaveBeenCalled();
  });

  it('counts detail rows and preserves the public response', async () => {
    const response = await detail(request, { params: Promise.resolve(params) });
    expect(response.status).toBe(200);
    expect(recordRows).toHaveBeenCalledWith(1);
    expect(await response.json()).not.toHaveProperty('catalogAngle');
    getClimb.mockResolvedValue(null);
    expect((await detail(request, { params: Promise.resolve(params) })).status).toBe(404);
    expect(recordRows).toHaveBeenLastCalledWith(0);
  });

  it('settles the actual setter rows after slug resolution and aggregation', async () => {
    expect((await setters(request, { params: Promise.resolve(params) })).status).toBe(200);
    expect(parseParams).toHaveBeenCalledOnce();
    expect(getSetters).toHaveBeenCalledOnce();
    expect(recordRows).toHaveBeenCalledWith(1);
  });
});
