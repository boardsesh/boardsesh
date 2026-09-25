// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The slot decides ONE thing: whether the route transport is on screen at all.
//
// #4761 made it unconditional on a multi-frame board, because route-ness could
// only be inferred from `frames.length > 1` and the feature was otherwise
// invisible — which charged every boulder 52dp of board for an advert. Route
// mode is now explicit state the header's overflow menu owns, so these cases pin
// the contract that replaces it: nothing at all unless the setter is authoring a
// route, and the transport in creator configuration when they are.

type ViewMockProps = { children?: ReactNode; testID?: string; accessibilityLabel?: string };
vi.mock('react-native', () => ({
  View: ({ children, testID, accessibilityLabel }: ViewMockProps) =>
    createElement('div', { 'data-testid': testID, 'data-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-node': 'gesture-root' }, children),
}));
// The real transport pulls Reanimated and a GestureDetector into jsdom; the slot
// only owes it the right props and the right mounting condition.
vi.mock('../../playback/PlaybackControls', () => ({
  PlaybackControls: ({
    frameCount,
    frameIndex,
    paceSeconds,
    magnetSeconds,
    frameEditing,
    onPaceSecondsChange,
  }: {
    frameCount?: number;
    frameIndex?: number;
    paceSeconds?: number;
    magnetSeconds?: number;
    frameEditing?: { onAddFrame: () => void };
    onPaceSecondsChange?: (seconds: number) => void;
  }) =>
    createElement('button', {
      'data-node': 'transport',
      'data-frames': frameCount,
      'data-index': frameIndex,
      'data-pace-seconds': paceSeconds,
      'data-magnet-seconds': magnetSeconds,
      'data-frame-editing': frameEditing ? 'yes' : 'no',
      onClick: () => onPaceSecondsChange?.(2.5),
    }),
}));

import { CreateRoutePlaybackSlot } from '../CreateRoutePlaybackSlot';

const playback = {
  isPlaying: false,
  paceMs: 750,
  play: vi.fn(),
  pause: vi.fn(),
  seek: vi.fn(),
};

function renderSlot(overrides: Partial<Parameters<typeof CreateRoutePlaybackSlot>[0]> = {}) {
  const onAddFrame = vi.fn();
  const onDeleteFrame = vi.fn();
  const onPaceChange = vi.fn();
  const { container } = render(
    createElement(CreateRoutePlaybackSlot, {
      showRouteTransport: true,
      frameCount: 1,
      frameIndex: 0,
      playback,
      wallStateLabel: null,
      onAddFrame,
      onDeleteFrame,
      onPaceChange,
      ...overrides,
    }),
  );
  return {
    container,
    onAddFrame,
    onDeleteFrame,
    onPaceChange,
    transport: container.querySelector('[data-node="transport"]'),
    gestureRoot: container.querySelector('[data-node="gesture-root"]'),
  };
}

describe('CreateRoutePlaybackSlot', () => {
  it('renders nothing for a boulder, however many frames it somehow has', () => {
    // The frame count is deliberately >1: a route that was never switched into
    // route mode cannot exist, and if one ever did, the flag still decides.
    const { container } = renderSlot({ showRouteTransport: false, frameCount: 3 });
    expect(container.innerHTML).toBe('');
  });

  it('mounts the transport from the FIRST frame of a route', () => {
    // The whole point of an explicit route mode: the transport no longer has to
    // wait for a second frame to exist, so the control that creates one is on
    // screen when you need it.
    const { transport } = renderSlot({ frameCount: 1, frameIndex: 0 });
    expect(transport).not.toBeNull();
    expect(transport?.getAttribute('data-frames')).toBe('1');
  });

  it('passes the frame position through to the transport', () => {
    const { transport } = renderSlot({ frameCount: 4, frameIndex: 2 });
    expect(transport?.getAttribute('data-frames')).toBe('4');
    expect(transport?.getAttribute('data-index')).toBe('2');
  });

  it('puts the transport in creator configuration: frame editing on', () => {
    // Creator-only. The play drawer mounts the same component without it and
    // keeps the plain counter, so a regression here is a regression there too.
    const { transport } = renderSlot({ frameCount: 2 });
    expect(transport?.getAttribute('data-frame-editing')).toBe('yes');
  });

  it('shows the draft pace in seconds, and magnets to the default rather than itself', () => {
    // The value being dragged cannot also be the thing the release snaps to, or
    // the magnet is sticky and the setter can never leave the pace they have.
    const { transport } = renderSlot({ frameCount: 2 });
    expect(transport?.getAttribute('data-pace-seconds')).toBe('0.75');
    expect(transport?.getAttribute('data-magnet-seconds')).toBe('0.75');
  });

  it('writes an authored pace back in milliseconds, which is what the column stores', () => {
    const { transport, onPaceChange } = renderSlot({ frameCount: 2 });
    (transport as HTMLButtonElement).click();
    expect(onPaceChange).toHaveBeenCalledWith(2500);
  });

  it('keeps the transport under its own gesture root', () => {
    // Load-bearing on Android: the pace slider is a GestureDetector and this
    // sheet is a Compose ModalBottomSheet the app's root GHRV does not cover.
    const { gestureRoot, transport } = renderSlot({ frameCount: 2 });
    expect(gestureRoot).not.toBeNull();
    expect(gestureRoot?.contains(transport)).toBe(true);
  });

  it('no longer renders a detached frame-actions row', () => {
    // Delete moved into the header's overflow menu and add became a chip inside
    // the transport card. Two rows collapsing into one card is the issue's
    // "integrate them cleanly" requirement; a button row here would undo it.
    // The transport stub itself is a button, so count what is NOT it.
    const { container, transport } = renderSlot({ frameCount: 3 });
    const buttons = Array.from(container.querySelectorAll('button')).filter((node) => node !== transport);
    expect(buttons).toHaveLength(0);
  });
});
