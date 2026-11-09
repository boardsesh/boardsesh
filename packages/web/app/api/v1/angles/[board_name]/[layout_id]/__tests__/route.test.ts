import { describe, it, expect, vi } from 'vite-plus/test';
import { ANGLES } from '@boardsesh/board-config';
import { GET } from '../route';

vi.mock('@/app/lib/public-api-rate-limit.server', () => ({
  enforcePublicApiRateLimit: vi.fn().mockResolvedValue(null),
}));

function callGet(boardName: string, layoutId: string) {
  const req = new Request(`http://localhost/api/v1/angles/${boardName}/${layoutId}`);
  return GET(req, { params: Promise.resolve({ board_name: boardName, layout_id: layoutId }) });
}

describe('GET /api/v1/angles/[board_name]/[layout_id]', () => {
  // Regression test for issue #2379: this route used to query
  // `kilter_products_angles` joined to a nonexistent `layouts` table (and
  // ignored the board_name param entirely) — always 500ing. Angles are now
  // read from the static ANGLES source shared with the GraphQL resolver.
  it('returns the static angle range for a valid Aurora board, ignoring layout_id', async () => {
    const res = await callGet('kilter', '1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ angle: number }>;
    expect(body).toEqual(ANGLES.kilter.map((angle) => ({ angle })));
  });

  it('parameterizes correctly on board_name instead of always returning kilter angles', async () => {
    const res = await callGet('tension', '9');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ angle: number }>;
    expect(body).toEqual(ANGLES.tension.map((angle) => ({ angle })));
  });

  it('returns 400 for an unknown board name', async () => {
    const res = await callGet('not-a-board', '1');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid board name');
  });
});
