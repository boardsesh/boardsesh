import { SETS } from '@boardsesh/board-constants';
import { describe, expect, it } from 'vitest';
import { MAX_SET_IDS, ogClimbQuerySchema } from '../validation';

/**
 * Tripwire for the render routes' hold-set ceiling.
 *
 * A board's `set_ids` are not a request parameter a caller chooses — they are
 * the whole hold-set list for that config, handed to us by the catalogue. So a
 * cap below the widest shipped config is not a safety bound, it is an outage
 * for that board: `MAX_SET_IDS = 10` against Decoy's 19 sets 400'd every Decoy
 * climb's share card and its server-rendered board image, and did so quietly,
 * because both the app's browser workers and the mobile app render the overlay
 * locally and never touch the HTTP endpoint.
 *
 * If a future board outgrows the cap, that must surface here.
 */
describe('every catalogue config fits under MAX_SET_IDS', () => {
  const configs = Object.entries(SETS).flatMap(([boardName, byLayoutAndSize]) =>
    Object.entries(byLayoutAndSize).map(([layoutAndSize, sets]) => ({
      label: `${boardName}/${layoutAndSize}`,
      boardName,
      layoutAndSize,
      setIds: sets.map((set) => set.id),
    })),
  );

  it('covers the whole catalogue', () => {
    expect(configs.length).toBeGreaterThan(50);
  });

  it('leaves the widest config under the cap', () => {
    const widest = configs.reduce((worst, config) => (config.setIds.length > worst.setIds.length ? config : worst));

    expect(
      widest.setIds.length,
      `${widest.label} carries ${widest.setIds.length} hold sets, over the MAX_SET_IDS cap of ${MAX_SET_IDS} in ` +
        'validation.ts. Raise the cap rather than letting every climb on that board 400 on /og/climb and ' +
        '/render/board.',
    ).toBeLessThanOrEqual(MAX_SET_IDS);
  });

  it('accepts every config through the og:climb query schema', () => {
    const rejected = configs.filter(
      (config) =>
        !ogClimbQuerySchema.safeParse({
          board_name: config.boardName,
          layout_id: config.layoutAndSize.split('-')[0],
          size_id: config.layoutAndSize.split('-')[1],
          set_ids: config.setIds.join(','),
          frames: 'p1r1',
        }).success,
    );

    expect(rejected.map((config) => config.label)).toEqual([]);
  });
});
