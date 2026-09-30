import { describe, expect, it, vi } from 'vitest';

// Capture the ops the mocked PowerSync stream should replay. vi.hoisted so the
// vi.mock factory (hoisted above imports) can close over it safely.
const hoisted = vi.hoisted(() => ({ ops: [] as Array<Record<string, unknown>>, signals: [] as unknown[] }));

vi.mock('../api/powersync-client', () => ({
  streamKilterPowerSync: async (args: {
    onOp: (op: Record<string, unknown>) => void | Promise<void>;
    signal?: AbortSignal;
  }) => {
    hoisted.signals.push(args.signal);
    for (const op of hoisted.ops) {
      await args.onOp(op);
    }
  },
}));

import { pullKilterReference } from './reference-pull';

function put(objectType: string, objectId: string, data: Record<string, unknown>): Record<string, unknown> {
  return { op_id: objectId, op: 'PUT', object_type: objectType, object_id: objectId, data };
}

const layoutOp = put('product_layouts', '27', {
  product_layout_uuid: '27',
  product_name: 'Kilter Board Original',
  is_listed: 1,
  edge_left: 0,
  edge_right: 144,
  edge_bottom: 12,
  edge_top: 156,
});

describe('pullKilterReference', () => {
  it('dedups repeated PUTs for the same wall/gym, last write wins', async () => {
    hoisted.ops = [
      layoutOp,
      // Same wall_uuid streamed twice (snapshot + update) — later op wins.
      put('walls', 'row-1', { wall_uuid: 'wall-a', product_name: 'Kilter Board Original', angle: 30, is_listed: 1 }),
      put('walls', 'row-1', { wall_uuid: 'wall-a', product_name: 'Kilter Board Original', angle: 40, is_listed: 1 }),
      // A distinct wall stays.
      put('walls', 'row-2', { wall_uuid: 'wall-b', product_name: 'Kilter Board Original', angle: 25, is_listed: 1 }),
      // Same gym_uuid twice — later name wins.
      put('gyms', 'g-1', { gym_uuid: 'gym-a', name: 'First Name' }),
      put('gyms', 'g-1', { gym_uuid: 'gym-a', name: 'Second Name' }),
    ];

    const reference = await pullKilterReference({ accessToken: 'token' });

    expect(reference.walls).toHaveLength(2);
    const wallA = reference.walls.find((wall) => wall.wallUuid === 'wall-a');
    expect(wallA?.angle).toBe(40);

    expect(reference.gyms).toHaveLength(1);
    expect(reference.gyms[0].name).toBe('Second Name');

    expect(reference.productLayouts).toHaveLength(1);
  });

  it('dedups product_layouts / holds / grades by their natural key', async () => {
    hoisted.ops = [
      layoutOp,
      // Duplicate product_layout row — collapses to one.
      { ...layoutOp, op_id: '27b' },
      put('holds', 'h-1', { hold_id: 100, hold_set_name: 'A' }),
      put('holds', 'h-1', { hold_id: 100, hold_set_name: 'A-renamed' }),
      put('difficulty_grades', 'd-1', { difficulty_grade_id: 10, boulder_difficulty: 'V4', is_listed: 1 }),
      put('difficulty_grades', 'd-1', { difficulty_grade_id: 10, boulder_difficulty: 'V5', is_listed: 1 }),
    ];

    const reference = await pullKilterReference({ accessToken: 'token' });

    expect(reference.productLayouts).toHaveLength(1);
    expect(reference.holds).toHaveLength(1);
    expect(reference.holds[0].holdSetName).toBe('A-renamed');
    expect(reference.difficultyGrades).toHaveLength(1);
    expect(reference.difficultyGrades[0].boulderDifficulty).toBe('V5');
  });

  it('throws when no product_layouts stream (cannot enumerate the catalog)', async () => {
    hoisted.ops = [put('walls', 'row-1', { wall_uuid: 'wall-a', is_listed: 1 })];
    await expect(pullKilterReference({ accessToken: 'token' })).rejects.toThrow(/no product_layouts/);
  });

  it("hands the caller's signal to the reference stream, so a stopped job does not wait out its timeout", async () => {
    hoisted.ops = [layoutOp];
    hoisted.signals = [];
    const controller = new AbortController();

    await pullKilterReference({ accessToken: 'token', signal: controller.signal });

    expect(hoisted.signals).toEqual([controller.signal]);
  });
});
