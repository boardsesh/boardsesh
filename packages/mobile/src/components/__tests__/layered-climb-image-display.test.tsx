// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  events: [] as Array<{ uri: string; load?: () => void; display?: () => void }>,
  hidden: false,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('expo-image', () => ({
  Image: ({ source, onLoad, onDisplay }: { source: { uri: string }; onLoad?: () => void; onDisplay?: () => void }) => {
    native.events.push({ uri: source.uri, load: onLoad, display: onDisplay });
    return createElement('img', { src: source.uri });
  },
}));
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => native.hidden }));
vi.mock('../board-art-visibility-context', () => ({ useBoardArtVisible: () => true }));
import { LayeredClimbImage } from '../LayeredClimbImage';

function latest(uri: string) {
  return native.events.filter((event) => event.uri === uri).at(-1)!;
}

describe('native artwork display handoff', () => {
  beforeEach(() => {
    native.events.length = 0;
    native.hidden = false;
  });
  it('requires display, not load, of every background and the exact overlay', () => {
    const displayed = vi.fn();
    render(
      createElement(LayeredClimbImage, {
        overlayUri: 'file:///holds.png',
        overlayLoadKey: '1:0',
        backgroundPaths: ['/board.webp', '/kick.webp'],
        onArtDisplayed: displayed,
      }),
    );
    act(() => {
      for (const event of native.events) event.load?.();
    });
    expect(displayed).not.toHaveBeenCalled();
    act(() => {
      latest('file:///holds.png').display?.();
      latest('file:///board.webp').display?.();
    });
    expect(displayed).not.toHaveBeenCalled();
    act(() => latest('file:///kick.webp').display?.());
    expect(displayed).toHaveBeenCalledExactlyOnceWith('1:0');
  });
  it('carries displayed unchanged backgrounds across recycled climbs, rejecting old overlay callbacks', () => {
    const displayed = vi.fn();
    const initial = {
      overlayUri: 'file:///same.png',
      overlayLoadKey: '1:0',
      backgroundPaths: ['/board.webp'],
      recyclingKey: 'first',
      onArtDisplayed: displayed,
    };
    const { rerender } = render(createElement(LayeredClimbImage, initial));
    const oldOverlay = latest('file:///same.png');
    act(() => latest('file:///board.webp').display?.());
    rerender(createElement(LayeredClimbImage, { ...initial, overlayLoadKey: '2:0', recyclingKey: 'second' }));
    act(() => oldOverlay.display?.());
    expect(displayed).not.toHaveBeenCalled();
    act(() => latest('file:///same.png').display?.());
    expect(displayed).toHaveBeenCalledExactlyOnceWith('2:0');
  });
  it('does not accept queued pre-hide display events when the same images remount', () => {
    const displayed = vi.fn();
    const props = {
      overlayUri: 'file:///holds.png',
      overlayLoadKey: '1:0',
      backgroundPaths: ['/board.webp'],
      onArtDisplayed: displayed,
    };
    const { rerender } = render(createElement(LayeredClimbImage, props));
    const stale = [...native.events];
    native.hidden = true;
    rerender(createElement(LayeredClimbImage, { ...props, displayIdentity: 'hidden' }));
    native.hidden = false;
    rerender(createElement(LayeredClimbImage, { ...props, displayIdentity: 'shown' }));
    act(() => {
      for (const event of stale) event.display?.();
    });
    expect(displayed).not.toHaveBeenCalled();
    act(() => {
      latest('file:///board.webp').display?.();
      latest('file:///holds.png').display?.();
    });
    expect(displayed).toHaveBeenCalledExactlyOnceWith('1:0');
  });
  it('retargets identical displayed images to a new climb without waiting for native events again', () => {
    const first = vi.fn();
    const second = vi.fn();
    const props = { overlayUri: 'file:///holds.png', overlayLoadKey: '1:0', backgroundPaths: ['/board.webp'] };
    const { rerender } = render(
      createElement(LayeredClimbImage, { ...props, displayIdentity: 'uuid-1', onArtDisplayed: first }),
    );
    act(() => {
      latest('file:///board.webp').display?.();
      latest('file:///holds.png').display?.();
    });
    expect(first).toHaveBeenCalledExactlyOnceWith('1:0');
    rerender(createElement(LayeredClimbImage, { ...props, displayIdentity: 'uuid-2', onArtDisplayed: second }));
    expect(second).toHaveBeenCalledExactlyOnceWith('1:0');
  });
});
