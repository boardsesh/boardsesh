// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { DiscoveryBoardItem } from '../BoardDiscoveryCard';

// Capture the props the card hands to BoardImageNative. The regression is that
// the discovery card omitted renderWidth, so the native renderer resolved the
// full-res board background (~1080-1461px) into a 168px cell on the main thread.
const boardImageProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: { select: (spec: Record<string, unknown>) => spec.ios },
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
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (initial: unknown) => ({ value: initial }),
  withSpring: (toValue: unknown) => toValue,
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
  });

  it('renders the thumbnail at a small renderWidth, not the full-res board source', () => {
    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn() }));

    expect(boardImageProps.last).not.toBeNull();
    // The discovery card cell is 168px; requesting renderWidth forces the
    // thumb-variant background + small overlay instead of a full-res decode.
    expect(boardImageProps.last?.renderWidth).toBe(400);
  });

  // Regression for the paired QA review on issue #3885's fix: the discovery
  // card used to hand BoardImageNative a flat width:'100%'/height:'100%' style,
  // which overrides its internal aspectRatio and stretches the art to fill the
  // square 168×168 thumb — for MoonBoard's new opaque wall backdrop that read as
  // a plain yellow square instead of a letterboxed board. The style must fit the
  // board's real aspect ratio inside the square cell instead.
  it('fits the board art to its real aspect ratio instead of stretching to the square thumb', () => {
    render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn() }));

    const style = boardImageProps.last?.style as { width?: number; height?: number } | undefined;
    // Mocked getBoardRenderData returns 1461x1144 (aspect ~1.277): width pins to
    // the 168px cell, height shrinks below it — not a stretched 168x168 square.
    expect(style?.width).toBe(168);
    expect(style?.height).toBeCloseTo(168 / (1461 / 1144), 2);
    expect(style?.height).not.toBe(168);
  });
});
