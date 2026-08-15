// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { DiscoveryBoardItem } from '../BoardDiscoveryCard';

// Capture the props the card hands to BoardImageNative. The regression is that
// the discovery card omitted renderWidth, so the native renderer resolved the
// full-res board background (~1080-1461px) into a 168px cell on the main thread.
const boardImageProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('div', { onClick: onPress, 'aria-label': accessibilityLabel, role: 'button' }, children),
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
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

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

  // The badge answers "is this board on my phone" without leaving the picker.
  it.each([
    ['downloaded', 'offline.downloaded'],
    ['downloading', 'offline.pending'],
    ['finalizing', 'offline.pending'],
    ['pending', 'offline.pending'],
  ] as const)('shows a status badge for a %s board', (offlineState, icon) => {
    const { container } = render(
      createElement(BoardDiscoveryCard, { item: { ...item, offlineState }, onPress: vi.fn() }),
    );
    expect(container.querySelector(`[data-icon="${icon}"]`)).not.toBeNull();
  });

  it('has no press target on a board that is already downloading', () => {
    const onDownload = vi.fn();
    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: { ...item, offlineState: 'downloading' },
        onPress: vi.fn(),
        onDownload,
      }),
    );
    fireEvent.click(container.querySelector('[data-icon="offline.pending"]')!.parentElement!);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it('offers a tappable download glyph only where the host wired one', () => {
    const onDownload = vi.fn();
    const downloadItem = { ...item, offlineState: 'off' as const };

    const withoutHandler = render(createElement(BoardDiscoveryCard, { item: downloadItem, onPress: vi.fn() }));
    expect(withoutHandler.container.querySelector('[data-icon="offline.download"]')).toBeNull();
    cleanup();

    const { container } = render(
      createElement(BoardDiscoveryCard, {
        item: downloadItem,
        onPress: vi.fn(),
        onDownload,
        downloadLabel: 'Make Tension 8x10 available offline',
      }),
    );
    const glyph = container.querySelector('[data-icon="offline.download"]')!.parentElement!;
    expect(glyph.getAttribute('aria-label')).toBe('Make Tension 8x10 available offline');
    fireEvent.click(glyph);
    expect(onDownload).toHaveBeenCalledWith(downloadItem);
  });

  // A popular config has no uuid, so rememberOfflineBoards drops it: its data
  // would download but the board could never appear in the offline picker.
  it('renders no offline affordance at all without an offlineState', () => {
    const { container } = render(createElement(BoardDiscoveryCard, { item, onPress: vi.fn(), onDownload: vi.fn() }));
    expect(container.querySelector('[data-icon="offline.download"]')).toBeNull();
    expect(container.querySelector('[data-icon="offline.downloaded"]')).toBeNull();
  });
});
