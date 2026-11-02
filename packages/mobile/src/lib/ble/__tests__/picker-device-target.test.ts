import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { classifyPickerDevice, groupPickerDevices } from '../picker-device-target';
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

describe('classifyPickerDevice', () => {
  it('claims the exact saved board identity as the target', () => {
    const resolutions = new Map<string, ResolvedBoardEntry>([['12345', { kind: 'saved', board: savedBoard() }]]);
    expect(classifyPickerDevice(kilter, resolutions, target)).toBe('target');
  });

  it('claims an exact recorded identity but sets apart another board with identical geometry', () => {
    expect(classifyPickerDevice(kilter, new Map([['12345', recorded('qa-kilter')]]), target)).toBe('target');
    expect(classifyPickerDevice(kilter, new Map([['12345', recorded('other-kilter')]]), target)).toBe('other');
  });

  it.each(['', null])('leaves anonymous geometry (UUID %s) unknown rather than claiming it', (boardUuid) => {
    expect(classifyPickerDevice(kilter, new Map([['12345', recorded(boardUuid)]]), target)).toBe('unknown');
  });

  it('leaves a recording for a board type this app does not know unknown', () => {
    expect(classifyPickerDevice(kilter, new Map([['12345', recorded('qa-kilter', 'not-a-board')]]), target)).toBe(
      'unknown',
    );
  });

  it('sets apart anonymous geometry recorded for a different board type', () => {
    expect(classifyPickerDevice(kilter, new Map([['12345', recorded(null, 'tension')]]), target)).toBe('other');
  });

  it.each([
    [kilter, tension],
    [tension, kilter],
  ])('never lets a different advertised type inherit a shared serial identity: %j', (...devices) => {
    const resolutions = new Map([['12345', recorded('qa-kilter')]]);
    const matches = devices.map((device) => [device.deviceId, classifyPickerDevice(device, resolutions, target)]);
    expect(Object.fromEntries(matches)).toEqual({ kilter: 'target', tension: 'other' });
  });

  it('sets apart a resolved identity whose type contradicts the target', () => {
    expect(classifyPickerDevice(kilter, new Map([['12345', recorded('qa-kilter', 'tension')]]), target)).toBe('other');
  });

  it('claims a serial-bearing advert with unknown type when its identity resolves exactly', () => {
    const unknown = { deviceId: 'unknown', name: 'Controller#12345@3', rssi: -40 };
    expect(classifyPickerDevice(unknown, new Map([['12345', recorded('qa-kilter')]]), target)).toBe('target');
  });

  it('leaves an unresolved serial of the target type unknown, never the target', () => {
    expect(classifyPickerDevice(kilter, new Map(), target)).toBe('unknown');
  });

  it('leaves a bare-name Kilter box unknown even when another Kilter serial resolves to the target', () => {
    const bareKilter = { ...kilter, name: 'Kilter Board' };
    expect(classifyPickerDevice(bareKilter, new Map([['12345', recorded('qa-kilter')]]), target)).toBe('unknown');
  });

  it('leaves a nameless or unparseable advert unknown', () => {
    expect(classifyPickerDevice({ deviceId: 'nameless', rssi: -60 }, new Map(), target)).toBe('unknown');
    expect(classifyPickerDevice({ deviceId: 'odd', name: 'LED Controller', rssi: -60 }, new Map(), target)).toBe(
      'unknown',
    );
  });

  it('sets apart the gym Tension at a Kilter connect with or without a serial (#7125)', () => {
    expect(classifyPickerDevice(tension, new Map(), target)).toBe('other');
    expect(classifyPickerDevice({ ...tension, name: 'Tension Board' }, new Map(), target)).toBe('other');
  });

  describe('for a MoonBoard', () => {
    const moonTarget = { boardUuid: 'qa-moon', boardName: 'moonboard' };

    it.each(['MoonBoard', 'Moonboard A'])('lists a stock "%s" advert, which carries no serial, as unknown', (name) => {
      expect(classifyPickerDevice({ deviceId: 'moon', name, rssi: -55 }, new Map(), moonTarget)).toBe('unknown');
    });

    it('sets apart Aurora boxes at a MoonBoard connect and a MoonBoard at a Kilter connect', () => {
      expect(classifyPickerDevice(kilter, new Map(), moonTarget)).toBe('other');
      expect(classifyPickerDevice({ deviceId: 'moon', name: 'MoonBoard', rssi: -55 }, new Map(), target)).toBe('other');
    });
  });
});

describe('groupPickerDevices', () => {
  it('splits a gym scan into the three groups in scan order', () => {
    const bareKilter = { deviceId: 'bare', name: 'Kilter Board', rssi: -45 };
    const strangerKilter = { deviceId: 'stranger', name: 'Kilter Board#777@3', rssi: -20 };
    const unrecordedKilter = { deviceId: 'unrecorded', name: 'Kilter Board#888@3', rssi: -65 };
    const resolutions = new Map([
      ['12345', recorded('qa-kilter')],
      ['777', recorded('other-kilter')],
    ]);
    const groups = groupPickerDevices(
      [tension, bareKilter, strangerKilter, kilter, unrecordedKilter],
      resolutions,
      target,
    );
    expect(groups.target.map((device) => device.deviceId)).toEqual(['kilter']);
    expect(groups.unknown.map((device) => device.deviceId)).toEqual(['bare', 'unrecorded']);
    expect(groups.other.map((device) => device.deviceId)).toEqual(['tension', 'stranger']);
  });

  // A box with no serial resolves to nothing, so it sat with the unknown rows
  // even when this phone had connected to it for this very board.
  it('puts the box this phone remembers for the board in the target group', () => {
    const bareKilter = { deviceId: 'bare', name: 'Kilter Board', rssi: -45 };
    const otherBareKilter = { deviceId: 'other-bare', name: 'Kilter Board', rssi: -30 };
    const groups = groupPickerDevices([otherBareKilter, tension, bareKilter, kilter], new Map(), {
      ...target,
      rememberedDeviceId: 'bare',
    });
    expect(groups.target.map((device) => device.deviceId)).toEqual(['bare']);
    expect(groups.unknown.map((device) => device.deviceId)).toEqual(['other-bare', 'kilter']);
    expect(groups.other.map((device) => device.deviceId)).toEqual(['tension']);
  });
});

describe('classifyPickerDevice with a remembered box', () => {
  it('claims a remembered MoonBoard, which carries no serial, as the target', () => {
    const moonTarget = { boardUuid: 'qa-moon', boardName: 'moonboard', rememberedDeviceId: 'moon' };
    expect(classifyPickerDevice({ deviceId: 'moon', name: 'MoonBoard', rssi: -55 }, new Map(), moonTarget)).toBe(
      'target',
    );
    expect(classifyPickerDevice({ deviceId: 'moon-2', name: 'MoonBoard', rssi: -55 }, new Map(), moonTarget)).toBe(
      'unknown',
    );
  });

  it('never lets the remembered id outrank an advertised type or a serial that names another board', () => {
    const remembered = { ...target, rememberedDeviceId: 'tension' };
    expect(classifyPickerDevice(tension, new Map(), remembered)).toBe('other');
    const strangerKilter = { deviceId: 'stranger', name: 'Kilter Board#777@3', rssi: -20 };
    expect(
      classifyPickerDevice(strangerKilter, new Map([['777', recorded('other-kilter')]]), {
        ...target,
        rememberedDeviceId: 'stranger',
      }),
    ).toBe('other');
  });
});
