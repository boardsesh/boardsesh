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
  // `SETS` is keyed `"<layoutId>-<sizeId>"`. Split it here rather than inside the
  // schema assertion so a key that stops matching that shape fails as a key
  // problem, instead of surfacing as a set_ids rejection and sending the next
  // reader after the wrong constant.
  const configs = Object.entries(SETS).flatMap(([boardName, byLayoutAndSize]) =>
    Object.entries(byLayoutAndSize).map(([layoutAndSize, sets]) => {
      const [layoutId, sizeId, ...rest] = layoutAndSize.split('-');
      return {
        label: `${boardName}/${layoutAndSize}`,
        boardName,
        layoutId,
        sizeId,
        hasWellFormedKey: rest.length === 0 && /^\d+$/.test(layoutId) && /^\d+$/.test(sizeId ?? ''),
        setIds: sets.map((set) => set.id),
      };
    }),
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

  it('keys every config as layoutId-sizeId', () => {
    const malformed = configs.filter((config) => !config.hasWellFormedKey);

    expect(malformed.map((config) => config.label)).toEqual([]);
  });

  it('accepts every config through the og:climb query schema', () => {
    const rejected = configs.map((config) => ({
      label: config.label,
      issues: ogClimbQuerySchema
        .safeParse({
          board_name: config.boardName,
          layout_id: config.layoutId,
          size_id: config.sizeId,
          set_ids: config.setIds.join(','),
          frames: 'p1r1',
        })
        .error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    }));

    // Report the schema's own message, so a rejection names the field it came
    // from rather than leaving the reader to guess it was set_ids.
    expect(rejected.filter((config) => config.issues)).toEqual([]);
  });
});
