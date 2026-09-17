import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import { selectBleBoardCandidates } from '../select-board-candidates';

function makeBoard(serialNumber: string, uuid: string, boardType = 'kilter'): UserBoard {
  return {
    uuid,
    slug: uuid,
    ownerId: 'owner-1',
    boardType,
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: uuid,
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: false,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
    serialNumber,
  };
}

function makeConfig(serialNumber: string, boardUuid: string | null, boardName = 'kilter'): BoardSerialConfig {
  return {
    serialNumber,
    boardName,
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    apiLevel: 3,
    updatedAt: '2026-01-02T00:00:00.000Z',
    boardUuid,
    boardSlug: null,
  };
}

describe('selectBleBoardCandidates', () => {
  const garage = makeBoard('751945', 'garage');
  const miles = makeBoard('751945', 'miles');

  it.each([[[garage, miles]], [[miles, garage]]])(
    'uses the saved Kilter pointer regardless of public-result order',
    (boards) => {
      expect(
        selectBleBoardCandidates(boards, [makeConfig('751945', 'garage')], new Map([['751945', 'kilter']])),
      ).toEqual([garage]);
    },
  );

  it('uses the other explicitly saved board when the climber chose it', () => {
    expect(selectBleBoardCandidates([garage, miles], [makeConfig('751945', 'miles')], new Map())).toEqual([miles]);
  });

  it.each([
    makeConfig('751945', null),
    makeConfig('751945', 'deleted-board'),
    makeConfig('different-serial', 'garage'),
  ])('keeps public candidates when a saved pointer cannot identify one', (config) => {
    expect(selectBleBoardCandidates([garage, miles], [config], new Map([['751945', 'kilter']]))).toEqual([
      garage,
      miles,
    ]);
  });

  it('does not let a Kilter pointer hide a Tension candidate with the same serial', () => {
    const tension = makeBoard('751945', 'tension', 'tension');

    expect(selectBleBoardCandidates([garage, miles, tension], [makeConfig('751945', 'garage')], new Map())).toEqual([
      garage,
      tension,
    ]);
  });

  it('does not use a pointer whose board type conflicts with the controller advertisement', () => {
    const tension = makeBoard('751945', 'tension', 'tension');

    expect(
      selectBleBoardCandidates(
        [garage, miles, tension],
        [makeConfig('751945', 'garage')],
        new Map([['751945', 'tension']]),
      ),
    ).toEqual([tension]);
  });
});
