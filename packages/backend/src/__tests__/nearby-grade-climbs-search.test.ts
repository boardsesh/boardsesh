import { describe, expect, it } from 'vitest';
import { boardClimbs, boardClimbStats } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { climbFieldResolvers } from '../graphql/resolvers/climbs/field-resolvers';
import { climbQueries } from '../graphql/resolvers/climbs/queries';

describe('anonymous nearby-grade climb search', () => {
  it('returns only listed, public, compatible climbs graded at the requested angle', async () => {
    const layoutId = 99783;
    const climbDefaults = {
      boardType: 'kilter',
      layoutId,
      isListed: true,
      isDraft: false,
      frames: 'p1r1',
      compatibleSizeIds: [23],
      requiredSetIds: [26],
    };
    await db.insert(boardClimbs).values([
      { ...climbDefaults, uuid: 'nearby-most-repeats' },
      { ...climbDefaults, uuid: 'nearby-fewer-repeats', requiredSetIds: [26, 27] },
      { ...climbDefaults, uuid: 'nearby-unlisted', isListed: false },
      { ...climbDefaults, uuid: 'nearby-draft', isDraft: true },
      { ...climbDefaults, uuid: 'nearby-hidden', isHidden: true },
      { ...climbDefaults, uuid: 'nearby-wrong-layout', layoutId: 1 },
      { ...climbDefaults, uuid: 'nearby-wrong-size', compatibleSizeIds: [17] },
      { ...climbDefaults, uuid: 'nearby-wrong-hold-set', requiredSetIds: [28] },
      { ...climbDefaults, uuid: 'nearby-wrong-angle' },
      { ...climbDefaults, uuid: 'nearby-outside-grade-band' },
    ]);

    const statsDefaults = { boardType: 'kilter', angle: 40, displayDifficulty: 23, ascensionistCount: 100 };
    await db.insert(boardClimbStats).values([
      { ...statsDefaults, climbUuid: 'nearby-most-repeats', ascensionistCount: 10, displayDifficulty: 22 },
      { ...statsDefaults, climbUuid: 'nearby-fewer-repeats', ascensionistCount: 7, displayDifficulty: 25 },
      { ...statsDefaults, climbUuid: 'nearby-unlisted' },
      { ...statsDefaults, climbUuid: 'nearby-draft' },
      { ...statsDefaults, climbUuid: 'nearby-hidden' },
      { ...statsDefaults, climbUuid: 'nearby-wrong-layout' },
      { ...statsDefaults, climbUuid: 'nearby-wrong-size' },
      { ...statsDefaults, climbUuid: 'nearby-wrong-hold-set' },
      { ...statsDefaults, climbUuid: 'nearby-wrong-angle', angle: 45 },
      { ...statsDefaults, climbUuid: 'nearby-outside-grade-band', displayDifficulty: 26 },
    ]);

    const context = await climbQueries.searchClimbs(
      null,
      {
        input: {
          boardName: 'kilter',
          layoutId,
          sizeId: 23,
          setIds: '26,27',
          angle: 40,
          minGrade: 22,
          maxGrade: 25,
          minAscents: 1,
          sortBy: 'ascents',
          sortOrder: 'desc',
          pageSize: 7,
        },
      },
      { isAuthenticated: false, connectionId: 'nearby-grade-climbs-search' } as ConnectionContext,
    );

    const climbs = await climbFieldResolvers.climbs(context);
    expect(climbs.map(({ uuid, statsAngle }) => ({ uuid, statsAngle }))).toEqual([
      { uuid: 'nearby-most-repeats', statsAngle: 40 },
      { uuid: 'nearby-fewer-repeats', statsAngle: 40 },
    ]);
  });
});
