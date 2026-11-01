import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { deviceMatchesPickerTarget } from '../picker-device-target';
import type { ResolvedBoardEntry } from '../resolve-serials';

const target = { boardUuid: 'qa-kilter', boardName: 'kilter' };
const kilter = { deviceId: 'kilter', name: 'Kilter Board#12345@3', rssi: -75 };
const tension = { deviceId: 'tension', name: 'Tension Board#12345@3', rssi: -30 };

function recorded(boardUuid: string | null, boardName = 'kilter'): ResolvedBoardEntry {
  return {
    kind: 'recorded',
    config: {
      serialNumber: '12345',
      boardName,
      boardUuid,
      boardSlug: null,
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      apiLevel: 3,
      updatedAt: '2026-10-30T00:00:00Z',
    },
  };
}

function savedBoard(): UserBoard {
  return {
    uuid: 'qa-kilter',
    slug: 'qa-kilter',
    ownerId: 'owner',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: 'QA Kilter',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: false,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-10-30T00:00:00Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
    serialNumber: '12345',
  };
}

describe('deviceMatchesPickerTarget', () => {
  it('accepts the exact saved board identity', () => {
    const resolutions = new Map<string, ResolvedBoardEntry>([['12345', { kind: 'saved', board: savedBoard() }]]);
    expect(deviceMatchesPickerTarget(kilter, resolutions, target)).toBe(true);
  });

  it('accepts an exact recorded identity but not another board with identical geometry', () => {
    expect(deviceMatchesPickerTarget(kilter, new Map([['12345', recorded('qa-kilter')]]), target)).toBe(true);
    expect(deviceMatchesPickerTarget(kilter, new Map([['12345', recorded('other-kilter')]]), target)).toBe(false);
  });

  it.each(['', null])('does not identify anonymous geometry by UUID %s', (boardUuid) => {
    expect(deviceMatchesPickerTarget(kilter, new Map([['12345', recorded(boardUuid)]]), target)).toBe(false);
  });

  it.each([
    [kilter, tension],
    [tension, kilter],
  ])('never lets a different advertised type inherit a shared serial identity: %j', (...devices) => {
    const resolutions = new Map([['12345', recorded('qa-kilter')]]);
    expect(devices.filter((device) => deviceMatchesPickerTarget(device, resolutions, target))).toEqual([kilter]);
  });

  it('rejects a resolved identity whose type contradicts the target', () => {
    expect(deviceMatchesPickerTarget(kilter, new Map([['12345', recorded('qa-kilter', 'tension')]]), target)).toBe(
      false,
    );
  });

  it('keeps a serial-bearing advert with unknown type when its identity resolves exactly', () => {
    const unknown = { deviceId: 'unknown', name: 'Controller#12345@3', rssi: -40 };
    expect(deviceMatchesPickerTarget(unknown, new Map([['12345', recorded('qa-kilter')]]), target)).toBe(true);
  });

  it('does not claim unresolved or serial-less devices as the intended board', () => {
    expect(deviceMatchesPickerTarget(kilter, new Map(), target)).toBe(false);
    expect(
      deviceMatchesPickerTarget(
        { ...kilter, name: 'Kilter Board' },
        new Map([['12345', recorded('qa-kilter')]]),
        target,
      ),
    ).toBe(false);
  });
});
