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
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
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
  it.each(['displayIdentity', 'paintedTestID', 'mirrored'] as const)(
    'accepts the real queued overlay display after only %s changes and reports the current capture',
    (metadata) => {
      const originalDisplayed = vi.fn();
      const currentDisplayed = vi.fn();
      const initial = {
        overlayUri: 'file:///holds.png',
        overlayLoadKey: '1:0',
        recyclingKey: 'same-native-image',
        backgroundPaths: ['/board.webp'],
        displayIdentity: 'opening-art',
        paintedTestID: metadata === 'displayIdentity' ? undefined : 'cpp-climb-painted-old',
        mirrored: false,
        onArtDisplayed: originalDisplayed,
      };
      const { rerender, queryByTestId } = render(createElement(LayeredClimbImage, initial));
      const actualQueuedOverlay = latest(initial.overlayUri);
      act(() => latest('file:///board.webp').display?.());
      const selected = {
        ...initial,
        displayIdentity: metadata === 'displayIdentity' ? 'visible-art' : initial.displayIdentity,
        paintedTestID: metadata === 'mirrored' ? 'cpp-climb-painted-current-mirrored' : 'cpp-climb-painted-current',
        mirrored: metadata === 'mirrored',
        onArtDisplayed: currentDisplayed,
      };
      rerender(createElement(LayeredClimbImage, selected));
      expect(queryByTestId(selected.paintedTestID)).toBeNull();
      act(() => actualQueuedOverlay.display?.());
      expect(queryByTestId(selected.paintedTestID)).not.toBeNull();
      expect(originalDisplayed).not.toHaveBeenCalled();
      expect(currentDisplayed).toHaveBeenCalledExactlyOnceWith('1:0');
    },
  );
  it('preserves genuine display of a still-mounted background when another required layer arrives', () => {
    const displayed = vi.fn();
    const initial = {
      overlayUri: 'file:///holds.png',
      overlayLoadKey: '1:0',
      backgroundPaths: ['/board.webp'],
      missingBackgroundCount: 1,
      paintedTestID: 'cpp-climb-painted-complete',
      onArtDisplayed: displayed,
    };
    const { rerender, queryByTestId } = render(createElement(LayeredClimbImage, initial));
    act(() => {
      latest('file:///board.webp').display?.();
      latest('file:///holds.png').display?.();
    });
    expect(queryByTestId(initial.paintedTestID)).toBeNull();
    expect(displayed).not.toHaveBeenCalled();
    rerender(
      createElement(LayeredClimbImage, {
        ...initial,
        backgroundPaths: ['/board.webp', '/kick.webp'],
        missingBackgroundCount: 0,
      }),
    );
    expect(queryByTestId(initial.paintedTestID)).toBeNull();
    act(() => latest('file:///kick.webp').load?.());
    expect(queryByTestId(initial.paintedTestID)).toBeNull();
    act(() => latest('file:///kick.webp').display?.());
    expect(queryByTestId(initial.paintedTestID)).not.toBeNull();
    expect(displayed).toHaveBeenCalledExactlyOnceWith('1:0');
  });
  it('accepts a queued background display from the same mounted image after the layer list expands', () => {
    const displayed = vi.fn();
    const initial = {
      overlayUri: 'file:///holds.png',
      overlayLoadKey: '1:0',
      backgroundPaths: ['/board.webp'],
      missingBackgroundCount: 1,
      paintedTestID: 'cpp-climb-painted-late-background',
      onArtDisplayed: displayed,
    };
    const { rerender, queryByTestId } = render(createElement(LayeredClimbImage, initial));
    const queuedBackground = latest('file:///board.webp');
    act(() => latest('file:///holds.png').display?.());
    rerender(
      createElement(LayeredClimbImage, {
        ...initial,
        backgroundPaths: ['/board.webp', '/kick.webp'],
        missingBackgroundCount: 0,
      }),
    );
    act(() => latest('file:///kick.webp').display?.());
    expect(queryByTestId(initial.paintedTestID)).toBeNull();
    act(() => queuedBackground.display?.());
    expect(queryByTestId(initial.paintedTestID)).not.toBeNull();
    expect(displayed).toHaveBeenCalledExactlyOnceWith('1:0');
  });
  it('rejects removed/readded background callbacks and requires display of the newly mounted same path', () => {
    const displayed = vi.fn();
    const initial = {
      overlayUri: 'file:///holds.png',
      overlayLoadKey: '1:0',
      backgroundPaths: ['/board.webp'],
      paintedTestID: 'cpp-climb-painted-remounted-background',
      onArtDisplayed: displayed,
    };
    const { rerender, queryByTestId } = render(createElement(LayeredClimbImage, initial));
    const removedBackground = latest('file:///board.webp');
    act(() => {
      removedBackground.display?.();
      latest('file:///holds.png').display?.();
    });
    expect(queryByTestId(initial.paintedTestID)).not.toBeNull();
    rerender(createElement(LayeredClimbImage, { ...initial, backgroundPaths: [], missingBackgroundCount: 1 }));
    rerender(createElement(LayeredClimbImage, initial));
    expect(queryByTestId(initial.paintedTestID)).toBeNull();
    act(() => removedBackground.display?.());
    expect(queryByTestId(initial.paintedTestID)).toBeNull();
    expect(displayed).toHaveBeenCalledTimes(1);
    act(() => latest('file:///board.webp').display?.());
    expect(queryByTestId(initial.paintedTestID)).not.toBeNull();
    expect(displayed).toHaveBeenCalledTimes(2);
  });
  it('requires a new actual overlay display after the same URI and load key unmount and remount', () => {
    const displayed = vi.fn();
    const props = {
      overlayUri: 'file:///holds.png',
      overlayLoadKey: '1:0',
      backgroundPaths: ['/board.webp'],
      paintedTestID: 'cpp-climb-painted-remounted-overlay',
      onArtDisplayed: displayed,
    };
    const { rerender, queryByTestId } = render(createElement(LayeredClimbImage, props));
    const removedOverlay = latest(props.overlayUri);
    act(() => {
      latest('file:///board.webp').display?.();
      removedOverlay.display?.();
    });
    expect(queryByTestId(props.paintedTestID)).not.toBeNull();
    rerender(createElement(LayeredClimbImage, { ...props, overlayUri: null }));
    rerender(createElement(LayeredClimbImage, props));
    expect(queryByTestId(props.paintedTestID)).toBeNull();
    act(() => removedOverlay.display?.());
    expect(queryByTestId(props.paintedTestID)).toBeNull();
    expect(displayed).toHaveBeenCalledTimes(1);
    act(() => latest(props.overlayUri).display?.());
    expect(queryByTestId(props.paintedTestID)).not.toBeNull();
    expect(displayed).toHaveBeenCalledTimes(2);
  });
  it.each(['overlayLoadKey', 'recyclingKey'] as const)(
    'rejects queued display after actual %s changes at the same URI',
    (physicalIdentity) => {
      const displayed = vi.fn();
      const props = {
        overlayUri: 'file:///holds.png',
        overlayLoadKey: '1:0',
        recyclingKey: 'first',
        backgroundPaths: ['/board.webp'],
        paintedTestID: 'cpp-climb-painted-new-attempt',
        onArtDisplayed: displayed,
      };
      const { rerender, queryByTestId } = render(createElement(LayeredClimbImage, props));
      const staleOverlay = latest(props.overlayUri);
      act(() => latest('file:///board.webp').display?.());
      rerender(
        createElement(LayeredClimbImage, {
          ...props,
          [physicalIdentity]: physicalIdentity === 'overlayLoadKey' ? '2:0' : 'second',
        }),
      );
      act(() => staleOverlay.display?.());
      expect(queryByTestId(props.paintedTestID)).toBeNull();
      expect(displayed).not.toHaveBeenCalled();
      act(() => latest(props.overlayUri).display?.());
      expect(queryByTestId(props.paintedTestID)).not.toBeNull();
      expect(displayed).toHaveBeenCalledExactlyOnceWith(physicalIdentity === 'overlayLoadKey' ? '2:0' : '1:0');
    },
  );
  it('rechecks unchanged genuinely displayed images only when the missing-layer barrier clears', () => {
    const displayed = vi.fn();
    const props = {
      overlayUri: 'file:///holds.png',
      overlayLoadKey: '1:0',
      backgroundPaths: ['/board.webp'],
      paintedTestID: 'cpp-climb-painted-no-missing-layer',
      onArtDisplayed: displayed,
    };
    const { rerender, queryByTestId } = render(
      createElement(LayeredClimbImage, { ...props, missingBackgroundCount: 1 }),
    );
    act(() => {
      latest('file:///board.webp').display?.();
      latest(props.overlayUri).display?.();
    });
    expect(queryByTestId(props.paintedTestID)).toBeNull();
    expect(displayed).not.toHaveBeenCalled();
    rerender(createElement(LayeredClimbImage, { ...props, missingBackgroundCount: 0 }));
    expect(queryByTestId(props.paintedTestID)).not.toBeNull();
    expect(displayed).toHaveBeenCalledExactlyOnceWith('1:0');
    rerender(createElement(LayeredClimbImage, { ...props, missingBackgroundCount: 0 }));
    expect(displayed).toHaveBeenCalledTimes(1);
  });
  it('exposes a selected-climb marker only after every current native image displays, and rejects stale callbacks after replacement', () => {
    const initial = {
      overlayUri: 'file:///first.png',
      overlayLoadKey: '1:0',
      backgroundPaths: ['/board.webp'],
      paintedTestID: 'cpp-climb-painted-owned-first',
    };
    const { rerender, queryByTestId } = render(createElement(LayeredClimbImage, initial));
    const stale = latest('file:///first.png');
    act(() => {
      latest('file:///first.png').load?.();
      latest('file:///board.webp').load?.();
    });
    expect(queryByTestId(initial.paintedTestID)).toBeNull();
    act(() => latest('file:///first.png').display?.());
    expect(queryByTestId(initial.paintedTestID)).toBeNull();
    act(() => latest('file:///board.webp').display?.());
    expect(queryByTestId(initial.paintedTestID)).not.toBeNull();
    const next = {
      ...initial,
      overlayUri: 'file:///second.png',
      overlayLoadKey: '2:0',
      paintedTestID: 'cpp-climb-painted-owned-second',
    };
    rerender(createElement(LayeredClimbImage, next));
    expect(queryByTestId(initial.paintedTestID)).toBeNull();
    expect(queryByTestId(next.paintedTestID)).toBeNull();
    act(() => stale.display?.());
    expect(queryByTestId(next.paintedTestID)).toBeNull();
    act(() => latest('file:///second.png').display?.());
    expect(queryByTestId(next.paintedTestID)).not.toBeNull();
    native.hidden = true;
    rerender(createElement(LayeredClimbImage, { ...next, displayIdentity: 'hidden' }));
    expect(queryByTestId(next.paintedTestID)).toBeNull();
    native.hidden = false;
    rerender(createElement(LayeredClimbImage, { ...next, displayIdentity: 'shown' }));
    expect(queryByTestId(next.paintedTestID)).toBeNull();
  });
  it('does not label missing or backgroundless artwork as a painted board', () => {
    const props = {
      overlayUri: 'file:///holds.png',
      overlayLoadKey: '1:0',
      backgroundPaths: [],
      paintedTestID: 'cpp-climb-painted-incomplete',
    };
    const { rerender, queryByTestId } = render(createElement(LayeredClimbImage, props));
    act(() => latest('file:///holds.png').display?.());
    expect(queryByTestId(props.paintedTestID)).toBeNull();
    rerender(
      createElement(LayeredClimbImage, { ...props, backgroundPaths: ['/board.webp'], missingBackgroundCount: 1 }),
    );
    act(() => latest('file:///board.webp').display?.());
    expect(queryByTestId(props.paintedTestID)).toBeNull();
  });
  it('binds mirror readiness to the actual transformed stack and reuses genuinely unchanged decoded images', () => {
    const base = {
      overlayUri: 'file:///holds.png',
      overlayLoadKey: '1:0',
      backgroundPaths: ['/board.webp'],
      paintedTestID: 'cpp-climb-painted-owned-climb',
      paintedExtraTestID: 'cpp-climb-local-mirror-owned-climb',
    };
    const { rerender, queryByTestId } = render(createElement(LayeredClimbImage, { ...base, mirrored: false }));
    act(() => {
      latest('file:///holds.png').display?.();
      latest('file:///board.webp').display?.();
    });
    expect(queryByTestId(base.paintedTestID)).not.toBeNull();
    expect(queryByTestId(base.paintedExtraTestID)).not.toBeNull();
    rerender(
      createElement(LayeredClimbImage, { ...base, mirrored: true, paintedTestID: `${base.paintedTestID}-mirrored` }),
    );
    expect(queryByTestId(base.paintedTestID)).toBeNull();
    expect(queryByTestId(`${base.paintedTestID}-mirrored`)).not.toBeNull();
    rerender(
      createElement(LayeredClimbImage, {
        ...base,
        mirrored: true,
        paintedTestID: `${base.paintedTestID}-mirrored`,
        paintedExtraTestID: undefined,
      }),
    );
    expect(queryByTestId(base.paintedExtraTestID)).toBeNull();
    expect(queryByTestId(`${base.paintedTestID}-mirrored`)).not.toBeNull();
  });
  it('keeps normal mirror changes on the original display identity without duplicate image reports', () => {
    const displayed = vi.fn();
    const props = {
      overlayUri: 'file:///holds.png',
      overlayLoadKey: '1:0',
      backgroundPaths: ['/board.webp'],
      displayIdentity: 'ordinary-art',
      onArtDisplayed: displayed,
    };
    const { rerender } = render(createElement(LayeredClimbImage, { ...props, mirrored: false }));
    act(() => {
      latest('file:///holds.png').display?.();
      latest('file:///board.webp').display?.();
    });
    expect(displayed).toHaveBeenCalledExactlyOnceWith('1:0');
    rerender(createElement(LayeredClimbImage, { ...props, mirrored: true }));
    act(() => {
      latest('file:///holds.png').display?.();
      latest('file:///board.webp').display?.();
    });
    expect(displayed).toHaveBeenCalledTimes(1);
    rerender(createElement(LayeredClimbImage, { ...props, mirrored: false }));
    expect(displayed).toHaveBeenCalledTimes(1);
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
