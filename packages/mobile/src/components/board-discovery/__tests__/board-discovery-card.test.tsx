// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { DiscoveryBoardItem } from '../BoardDiscoveryCard';

// Capture the props the card hands to BoardImageNative. The regression is that
// the discovery card omitted renderWidth, so the native renderer resolved the
// full-res board background (~1080-1461px) into a 168px cell on the main thread.
const boardImageProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
const nativePlatform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
const reanimatedMock = vi.hoisted(() => ({
  useAnimatedStyle: vi.fn((factory: () => unknown) => factory()),
  useSharedValue: vi.fn((initial: unknown) => ({ value: initial })),
  withSpring: vi.fn((toValue: unknown) => toValue),
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: {
    get OS() {
      return nativePlatform.OS;
    },
    select: (spec: Record<string, unknown>) => spec.ios,
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

// Reanimated host components: passthrough + no-op hooks so the card renders in
// jsdom without the native runtime.
vi.mock('react-native-reanimated', () => ({
  default: {
    createAnimatedComponent:
      () =>
      ({ children }: { children?: ReactNode }) =>
        createElement('div', null, children),
  },
  useAnimatedStyle: reanimatedMock.useAnimatedStyle,
  useSharedValue: reanimatedMock.useSharedValue,
  withSpring: reanimatedMock.withSpring,
}));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../theme/animations', () => ({ springs: { snappy: {} } }));
vi.mock('../../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 4 }),
  borderRadius: { lg: 12, md: 8, full: 999 },
  overlays: { scrim: '#0008', onScrim: '#fff' },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { tertiaryBackground: '#eee', separator: '#ccc', tertiaryLabel: '#999', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));

// A non-null render keeps the card on the BoardImageNative branch.
vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({ boardWidth: 1461, boardHeight: 1144 }),
}));

vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: (props: Record<string, unknown>) => {
    boardImageProps.last = props;
    return createElement('div', { 'data-testid': 'board-image' });
  },
}));

import { BoardDiscoveryCard } from '../BoardDiscoveryCard';

const item: DiscoveryBoardItem = {
  key: 'popular:tension:9:8:1-2',
  boardName: 'tension',
  layoutId: 9,
  sizeId: 8,
  setIds: '1,2',
  title: 'Tension 8x10',
};

describe('BoardDiscoveryCard', () => {
  afterEach(() => {
    cleanup();
    boardImageProps.last = null;
    nativePlatform.OS = 'ios';
    reanimatedMock.useAnimatedStyle.mockClear();
    reanimatedMock.useSharedValue.mockClear();
    reanimatedMock.withSpring.mockClear();
  });

  it('renders the thumbnail at a small renderWidth, not the full-res board source', () => {
    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn() }));

    expect(boardImageProps.last).not.toBeNull();
    // The discovery card cell is 168px; requesting renderWidth forces the
    // thumb-variant background + small overlay instead of a full-res decode.
    expect(boardImageProps.last?.renderWidth).toBe(400);
  });

  it('uses the static Pressable path on Android', () => {
    nativePlatform.OS = 'android';

    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn() }));

    expect(boardImageProps.last).not.toBeNull();
    expect(reanimatedMock.useSharedValue).not.toHaveBeenCalled();
    expect(reanimatedMock.useAnimatedStyle).not.toHaveBeenCalled();
  });
});
