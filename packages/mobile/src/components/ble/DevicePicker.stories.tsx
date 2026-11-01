import { useCallback, useState } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { StoryModule } from '../../dev/stories/types';
import type { BleBoardConfig } from '../../lib/ble/board-config-match';
import type { ResolvedBoardEntry } from '../../lib/ble/resolve-serials';
import type { DiscoveredDevice } from '../../lib/ble/types';
import { DevicePickerSheet } from './DevicePickerSheet';

const KILTER_UUID = '71250000-0000-4000-8000-000000000001';
const TENSION_UUID = '71250000-0000-4000-8000-000000000002';
const KILTER_CONFIG: BleBoardConfig = {
  boardName: 'kilter',
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  boardUuid: KILTER_UUID,
};
const TARGET_BOARD = { boardUuid: KILTER_UUID, boardName: 'kilter' };
const DEVICES: DiscoveredDevice[] = [
  { deviceId: 'qa-tension', name: 'Tension Board#99000002@3', rssi: -40 },
  { deviceId: 'qa-kilter', name: 'Kilter Board#99000001@3', rssi: -70 },
];

function fixtureBoard(boardUuid: string, boardType: string, name: string, serialNumber: string): UserBoard {
  return {
    uuid: boardUuid,
    slug: boardType === 'kilter' ? 'qa-kilter' : 'qa-tension',
    ownerId: 'qa-owner',
    boardType,
    layoutId: boardType === 'kilter' ? 8 : 10,
    sizeId: boardType === 'kilter' ? 25 : 6,
    setIds: boardType === 'kilter' ? '26,27,28,29' : '12,13',
    name,
    gymName: 'Boardsesh QA gym',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: false,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-10-30T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
    serialNumber,
  };
}

const RESOLVED_BOARDS = new Map<string, ResolvedBoardEntry>([
  ['99000001', { kind: 'saved', board: fixtureBoard(KILTER_UUID, 'kilter', 'QA Kilter Homewall Full', '99000001') }],
  ['99000002', { kind: 'saved', board: fixtureBoard(TENSION_UUID, 'tension', 'QA Tension 2 Mirror', '99000002') }],
]);

function GymBoardPicker({ initiallyShowAll = false, targetMissing = false }) {
  const [showAllBoards, setShowAllBoards] = useState(initiallyShowAll);
  const [open, setOpen] = useState(true);
  const handleSearchAnyBoard = useCallback(() => setShowAllBoards(true), []);
  const handleDismiss = useCallback(() => setOpen(false), []);

  return (
    <DevicePickerSheet
      devices={targetMissing ? DEVICES.slice(0, 1) : DEVICES}
      resolvedBoards={RESOLVED_BOARDS}
      currentBoardConfig={KILTER_CONFIG}
      targetBoard={TARGET_BOARD}
      showAllBoards={showAllBoards}
      isScanning={false}
      open={open}
      onDismiss={handleDismiss}
      onSelect={handleDismiss}
      onSearchAnyBoard={handleSearchAnyBoard}
    />
  );
}

const stories: StoryModule = {
  title: 'Bluetooth / Gym board picker',
  stories: {
    firstConnection: {
      name: 'First Kilter connection beside a stronger Tension',
      layout: 'fullscreen',
      render: () => <GymBoardPicker />,
    },
    allBoards: {
      name: 'Search for any board reveals both boards',
      layout: 'fullscreen',
      render: () => <GymBoardPicker initiallyShowAll />,
    },
    targetMissing: {
      name: 'The intended Kilter is not advertising',
      layout: 'fullscreen',
      render: () => <GymBoardPicker targetMissing />,
    },
  },
};

export default stories;
