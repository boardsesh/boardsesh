// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadyBoardArtSource } from '../../lib/board-render/ready-board-art';
const native = vi.hoisted(() => ({ read: vi.fn(), displays: [] as Array<(loadKey: string | null) => void> }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { fill: '#ddd' } }) }));
vi.mock('../../theme/tokens', () => ({ borderRadius: { md: 12 } }));
vi.mock('../../lib/board-render/warm-board-art-memory', () => ({
  isBoardArtInMemory: () => false,
  warmBoardArtMemory: vi.fn(),
}));
vi.mock('../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: ({ frames }: { frames: string }) => ({
    overlayUri: 'file:///same.png',
    overlayLoadKey: frames === 'first' ? '1:0' : '2:0',
    backgroundPaths: ['/board.webp'],
    artworkIdentity: { frames },
    getReadyBoardArtSnapshot: native.read,
  }),
}));
vi.mock('../LayeredClimbImage', () => ({
  LayeredClimbImage: ({ onArtDisplayed }: { onArtDisplayed: (key: string | null) => void }) => {
    native.displays.push(onArtDisplayed);
    return null;
  },
}));
import { ClimbListThumbnail } from '../ClimbListThumbnail';

describe('recycled thumbnail opening artwork', () => {
  beforeEach(() => {
    native.read.mockReset();
    native.displays.length = 0;
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
