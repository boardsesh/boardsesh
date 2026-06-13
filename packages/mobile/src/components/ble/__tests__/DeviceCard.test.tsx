// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import type { ResolvedBoardEntry } from '../../../lib/ble/resolve-serials';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (colorName: string) => colorName,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    style?: unknown;
  }) => createElement('button', { 'aria-label': accessibilityLabel }, children),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { time?: string }) => {
      if (key === 'devicePicker.lastConnectedAt') return `Last connected ${options?.time ?? ''}`;
      if (key === 'devicePicker.lastConnected') return 'Last connected board';
      if (key === 'devicePicker.unknownDevice') return 'Unknown device';
      return key;
    },
  }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: ({ boardName }: { boardName: string }) => createElement('div', { 'data-board-image': boardName }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#111111',
      secondaryLabel: '#666666',
      tertiaryLabel: '#999999',
      fill: '#eeeeee',
      background: '#ffffff',
      secondaryBackground: '#f8f8f8',
      tertiaryBackground: '#f0f0f0',
    },
  }),
}));

vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: {
    systemGreen: '#34c759',
    systemYellow: '#ffcc00',
    systemRed: '#ff3b30',
  },
}));

vi.mock('../../../lib/haptics', () => ({
  hapticLight: vi.fn(),
}));

vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: vi.fn(() => ({
    boardWidth: 100,
    boardHeight: 200,
    edgeLeft: 0,
    edgeRight: 100,
    edgeBottom: 0,
    edgeTop: 200,
    backgroundImageKeys: [],
    holdsData: [],
  })),
}));

import { DeviceCard, describeSavedBoard, getPreviewImageStyle } from '../DeviceCard';

function makeBoard(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    id: 1,
    uuid: 'board-1',
    slug: 'board-1',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: 'Garage Kilter',
    isPublic: false,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    layoutName: 'Homewall',
    sizeName: '12x12',
    setNames: ['Original', 'Aux'],
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    serialNumber: 'SN-1',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<BoardSerialConfig> = {}): BoardSerialConfig {
  return {
    serialNumber: 'SN-2',
    boardName: 'tension',
    layoutId: 1,
    sizeId: 10,
    setIds: '1',
    apiLevel: 2,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    boardUuid: null,
    boardSlug: null,
    ...overrides,
  };
}

describe('DeviceCard', () => {
  it('uses the saved board name and preview when a serial resolves to a UserBoard', () => {
    const resolvedEntry: ResolvedBoardEntry = { kind: 'saved', board: makeBoard() };

    const { container, getByText } = render(
      <DeviceCard
        device={{ deviceId: 'device-1', name: 'Kilter Board#SN-1@3', rssi: -45 }}
        onSelect={vi.fn()}
        resolvedEntry={resolvedEntry}
      />,
    );

    expect(getByText('Garage Kilter')).not.toBeNull();
    expect(getByText('Kilter')).not.toBeNull();
    expect(container.querySelector('[data-board-image="kilter"]')).not.toBeNull();
  });

  it('uses recorded config previews for previously connected controllers', () => {
    const resolvedEntry: ResolvedBoardEntry = { kind: 'recorded', config: makeConfig() };

    const { container, getByText } = render(
      <DeviceCard
        device={{ deviceId: 'device-2', name: 'Tension Board#SN-2@2', rssi: -55 }}
        onSelect={vi.fn()}
        resolvedEntry={resolvedEntry}
      />,
    );

    expect(getByText('Tension Board#SN-2@2')).not.toBeNull();
    expect(getByText('Tension')).not.toBeNull();
    expect(container.querySelector('[data-board-image="tension"]')).not.toBeNull();
  });

  it('falls back to the active board preview for unresolved devices', () => {
    const { container, getByText } = render(
      <DeviceCard
        device={{ deviceId: 'device-3', name: 'Kilter Board#SN-3@3', rssi: -70 }}
        onSelect={vi.fn()}
        currentBoardConfig={{ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' }}
      />,
    );

    expect(getByText('Kilter Board#SN-3@3')).not.toBeNull();
    expect(container.querySelector('[data-board-image="kilter"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="info"]')).not.toBeNull();
  });

  it('does not use the active board preview when an unresolved device name identifies another board', () => {
    const { container, getByText } = render(
      <DeviceCard
        device={{ deviceId: 'device-4', name: 'Tension Board#SN-4@2', rssi: -70 }}
        onSelect={vi.fn()}
        currentBoardConfig={{ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' }}
      />,
    );

    expect(getByText('Tension')).not.toBeNull();
    expect(container.querySelector('[data-board-image="kilter"]')).toBeNull();
    expect(container.querySelector('[data-icon="boards"]')).not.toBeNull();
  });

  it('drops empty set-ID segments instead of rendering with a bogus set 0', async () => {
    // `Number('')` is 0, so a malformed "1,,20" must parse to [1, 20] — not
    // [1, 0, 20], which would feed a nonexistent set to the board renderer.
    const { getBoardRenderData } = await import('../../../lib/board-details');
    vi.mocked(getBoardRenderData).mockClear();

    render(
      <DeviceCard
        device={{ deviceId: 'device-5', name: 'Kilter Board#SN-5@3', rssi: -50 }}
        onSelect={vi.fn()}
        currentBoardConfig={{ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,,20' }}
      />,
    );

    expect(vi.mocked(getBoardRenderData)).toHaveBeenCalledWith(expect.objectContaining({ setIds: [1, 20] }));
  });
});

describe('getPreviewImageStyle', () => {
  it('fits a portrait board to the max height', () => {
    expect(getPreviewImageStyle(100, 200)).toEqual({ width: 29, height: 58 });
  });

  it('fits a landscape board to the max width', () => {
    expect(getPreviewImageStyle(200, 100)).toEqual({ width: 58, height: 29 });
  });

  it('keeps a square board at the full thumbnail size', () => {
    expect(getPreviewImageStyle(100, 100)).toEqual({ width: 58, height: 58 });
  });

  it('falls back to a square for corrupt dimensions instead of an invisible strip', () => {
    expect(getPreviewImageStyle(100, 0)).toEqual({ width: 58, height: 58 });
    expect(getPreviewImageStyle(0, 200)).toEqual({ width: 58, height: 58 });
    expect(getPreviewImageStyle(Number.NaN, 200)).toEqual({ width: 58, height: 58 });
    expect(getPreviewImageStyle(-100, 200)).toEqual({ width: 58, height: 58 });
  });
});

describe('describeSavedBoard', () => {
  it('joins location and board specs', () => {
    expect(describeSavedBoard({ kind: 'saved', board: makeBoard({ gymName: 'Beta Cave' }) })).toBe(
      'Beta Cave, Homewall, 12x12, Original, Aux',
    );
  });

  it('returns undefined when every optional descriptor is missing', () => {
    const bareBoard = makeBoard({
      gymName: undefined,
      locationName: undefined,
      layoutName: undefined,
      sizeName: undefined,
      setNames: undefined,
    });
    expect(describeSavedBoard({ kind: 'saved', board: bareBoard })).toBeUndefined();
  });
});
