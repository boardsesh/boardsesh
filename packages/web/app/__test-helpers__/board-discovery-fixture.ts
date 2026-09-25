import type { BoardDiscoveryBoard } from '@boardsesh/shared-schema';

export function discoveryBoard(overrides: Partial<BoardDiscoveryBoard> = {}): BoardDiscoveryBoard {
  return {
    uuid: 'board-one',
    slug: 'northside-kilter',
    name: 'Training room Kilter',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    gymUuid: 'gym-1',
    gymName: 'Northside Boulders',
    gymSlug: 'northside-boulders',
    locationName: 'Sydney',
    uniqueClimbers: 12,
    currentClimb: null,
    ...overrides,
  };
}
