// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadyBoardArtSource } from '../../lib/board-render/ready-board-art';
const native = vi.hoisted(() => ({
  read: vi.fn(),
  displays: [] as Array<(loadKey: string | null) => void>,
  readiness: [] as Array<(ready: boolean) => void>,
  backgroundsLoading: false,
  missingCount: 0,
  paths: ['/board.webp'],
  overlayUri: 'file:///same.png' as string | null,
  overlayUnavailable: false,
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  PixelRatio: { get: () => 3 },
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { fill: '#ddd' } }) }));
vi.mock('../../theme/tokens', () => ({ borderRadius: { md: 12 } }));
vi.mock('../../lib/board-render/warm-board-art-memory', () => ({
  isBoardArtInMemory: () => false,
  warmBoardArtMemory: vi.fn(),
}));
vi.mock('../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: ({ frames }: { frames: string }) => ({
    overlayUri: native.overlayUri,
    overlayLoadKey: frames === 'first' ? '1:0' : '2:0',
    backgroundPaths: native.paths,
    backgroundsLoading: native.backgroundsLoading,
    missingBackgroundCount: native.missingCount,
    overlayUnavailable: native.overlayUnavailable,
    artworkIdentity: { frames },
    getReadyBoardArtSnapshot: native.read,
  }),
}));
vi.mock('../LayeredClimbImage', () => ({
  LayeredClimbImage: ({
    onArtDisplayed,
    onArtReadinessChange,
  }: {
    onArtDisplayed: (key: string | null) => void;
    onArtReadinessChange: (ready: boolean) => void;
  }) => {
    native.displays.push(onArtDisplayed);
    native.readiness.push(onArtReadinessChange);
    return null;
  },
}));
import { ClimbListThumbnail } from '../ClimbListThumbnail';

describe('recycled thumbnail opening artwork', () => {
  beforeEach(() => {
    native.read.mockReset();
    native.displays.length = 0;
    native.readiness.length = 0;
    native.backgroundsLoading = false;
    native.missingCount = 0;
    native.paths = ['/board.webp'];
    native.overlayUri = 'file:///same.png';
    native.overlayUnavailable = false;
  });
  it.each([0, 1])('waits for downloads then reports %s missing backgrounds', (remainingMissing) => {
    native.backgroundsLoading = true;
    native.missingCount = 1;
    native.paths = [];
    const onArtDisplayed = vi.fn();
    const onArtError = vi.fn();
    const props = {
      boardName: 'kilter' as const,
      layoutId: 1,
      sizeId: 2,
      setIds: '3',
      frames: 'first',
      onArtDisplayed,
      onArtError,
    };
    const { rerender } = render(createElement(ClimbListThumbnail, props));
    const pendingReady = native.readiness.at(-1)!;
    act(() => {
      native.displays.at(-1)!('1:0');
      pendingReady(true);
    });
    expect(onArtError).not.toHaveBeenCalled();
    expect(onArtDisplayed).not.toHaveBeenCalled();
    native.backgroundsLoading = false;
    native.missingCount = remainingMissing;
    native.paths = remainingMissing ? [] : ['/board.webp'];
    rerender(createElement(ClimbListThumbnail, { ...props, size: { width: 80, height: 100 } }));
    act(() => {
      pendingReady(true);
      native.readiness.at(-1)!(true);
      native.readiness.at(-1)!(true);
    });
    if (remainingMissing) {
      expect(onArtError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Board background artwork unavailable' }),
      );
      expect(onArtDisplayed).not.toHaveBeenCalled();
    } else {
      expect(onArtError).not.toHaveBeenCalled();
      expect(onArtDisplayed).toHaveBeenCalledOnce();
    }
  });

  it.each([false, true])('never blesses an absent or unavailable hold overlay (unavailable=%s)', (unavailable) => {
    native.overlayUri = unavailable ? 'file:///stale-overlay.png' : null;
    native.overlayUnavailable = unavailable;
    const onArtDisplayed = vi.fn();
    const onArtError = vi.fn();
    render(
      createElement(ClimbListThumbnail, {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 2,
        setIds: '3',
        frames: 'first',
        onArtDisplayed,
        onArtError,
      }),
    );
    act(() => {
      native.displays.at(-1)!(null);
      native.readiness.at(-1)!(true);
    });
    expect(onArtDisplayed).not.toHaveBeenCalled();
    expect(onArtError).toHaveBeenCalledTimes(unavailable ? 1 : 0);
  });

  it('requires native paint readiness even when every asset is available', () => {
    const onArtDisplayed = vi.fn();
    render(
      createElement(ClimbListThumbnail, {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 2,
        setIds: '3',
        frames: 'first',
        onArtDisplayed,
      }),
    );
    act(() => {
      native.displays.at(-1)!('1:0');
      native.readiness.at(-1)!(false);
    });
    expect(onArtDisplayed).not.toHaveBeenCalled();
    act(() => native.readiness.at(-1)!(true));
    expect(onArtDisplayed).toHaveBeenCalledOnce();
  });

  it('never lets the previous recycled row display publish readiness for the new climb', () => {
    const source: { current: ReadyBoardArtSource | null } = { current: null };
    const scope = { boardName: 'kilter' as const, layoutId: 1, sizeId: 2, setIds: '3', readyBoardArtRef: source };
    const { rerender } = render(
      createElement(ClimbListThumbnail, { ...scope, frames: 'first', climbUuid: 'first-uuid' }),
    );
    const oldDisplay = native.displays.at(-1)!;
    const oldSource = source.current!;
    rerender(createElement(ClimbListThumbnail, { ...scope, frames: 'second', climbUuid: 'second-uuid' }));
    act(() => oldDisplay('1:0'));
    oldSource.read();
    expect(native.read).not.toHaveBeenCalled();
    source.current!.read();
    expect(native.read).toHaveBeenCalledExactlyOnceWith('second-uuid', false, null);
    act(() => native.displays.at(-1)!('2:0'));
    source.current!.read();
    expect(native.read).toHaveBeenLastCalledWith('second-uuid', false, '2:0');
  });
});
