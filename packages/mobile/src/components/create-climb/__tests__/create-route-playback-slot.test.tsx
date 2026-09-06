// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The slot is the only route affordance a fresh create sheet has. #4761 came
// back QA-declined because the transport mounted only at two frames and the one
// control that made a second frame was a bare `copy` glyph fourth inside the
// action bar's horizontal scroller — so a climber saw no play control and no
// sign routes existed. These cases pin the three states that fixes: nothing on a
// board that can't hold a route, a self-explaining strip on a fresh climb, and
// the real transport once there is something to play.

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
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name?: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, minHeight }: { title?: string; onPress?: () => void; minHeight?: number }) =>
    createElement('button', { 'data-add-frame': 'true', 'data-min-height': minHeight, onClick: onPress }, title),
}));
vi.mock('../../Button.surface', () => ({
  ButtonSurfaceProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
// The real transport pulls Reanimated and a GestureDetector into jsdom; the slot
// only owes it the right props and the right mounting condition.
vi.mock('../../playback/PlaybackControls', () => ({
  PlaybackControls: ({ frameCount, frameIndex }: { frameCount?: number; frameIndex?: number }) =>
    createElement('div', { 'data-node': 'transport', 'data-frames': frameCount, 'data-index': frameIndex }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { separator: '#C6C6C8', tertiaryLabel: '#3C3C4399' } }),
}));
vi.mock('../../../theme/layout', () => ({ glassSize: { inline: 44 } }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 4: 16 },
  borderRadius: { lg: 12 },
}));

import { CreateRoutePlaybackSlot } from '../CreateRoutePlaybackSlot';

const playback = {
  isPlaying: false,
  speed: 1,
  paceMs: 750,
  play: vi.fn(),
  pause: vi.fn(),
  seek: vi.fn(),
  setSpeed: vi.fn(),
};

function renderSlot(overrides: Partial<Parameters<typeof CreateRoutePlaybackSlot>[0]> = {}) {
  const onAddFrame = vi.fn();
  const { container } = render(
    createElement(CreateRoutePlaybackSlot, {
      supportsMultiFrame: true,
      frameCount: 1,
      frameIndex: 0,
      playback,
      wallStateLabel: null,
      onAddFrame,
      ...overrides,
    }),
  );
  return {
    container,
    onAddFrame,
    strip: container.querySelector('[data-testid="create-route-playback-empty"]') as HTMLElement | null,
    transport: container.querySelector('[data-node="transport"]') as HTMLElement | null,
    addFrame: container.querySelector('[data-add-frame="true"]') as HTMLButtonElement | null,
  };
}

describe('CreateRoutePlaybackSlot', () => {
  it('renders nothing on a board that cannot hold a second frame', () => {
    // Woods lights one static frame, and a two-frame string carries a comma its
    // packet builder rejects outright. Offering the strip there would advertise
    // a climb the wall then refuses to light.
    const { container } = renderSlot({ supportsMultiFrame: false });
    expect(container.innerHTML).toBe('');

    const asRoute = renderSlot({ supportsMultiFrame: false, frameCount: 3, frameIndex: 1 });
    expect(asRoute.container.innerHTML).toBe('');
  });

  it('offers a named way in on a single-frame climb', () => {
    const { strip, transport, addFrame, container } = renderSlot({ frameCount: 1 });

    expect(strip).toBeTruthy();
    expect(transport).toBeNull();
    // The strip says what it is, so the feature is not a glyph hunt.
    expect(container.textContent).toContain('mobile.create.playback.emptyHint');
    expect(addFrame).toBeTruthy();
    expect(addFrame?.textContent).toContain('mobile.create.playback.addFrame');
    expect(strip?.getAttribute('data-label')).toBe('mobile.create.playback.emptyA11y');
    // The play glyph is inert here — a control that played nothing would be half
    // of "the play button doesn't work".
    expect(container.querySelector('[data-icon="play.circle"]')).toBeTruthy();
  });

  it('floors the Add frame pill at the 44dp touch target', () => {
    // Compose sizes a small filled button at 40, and this one shares a row with
    // a 44dp-tall glyph.
    const { addFrame } = renderSlot({ frameCount: 1 });
    expect(addFrame?.getAttribute('data-min-height')).toBe('44');
  });

  it('adds the frame when the pill is pressed', () => {
    const { addFrame, onAddFrame } = renderSlot({ frameCount: 1 });

    addFrame?.click();
    expect(onAddFrame).toHaveBeenCalledTimes(1);
  });

  it('swaps the strip for the real transport once there is a route to play', () => {
    const { strip, transport, addFrame } = renderSlot({ frameCount: 2, frameIndex: 1 });

    expect(strip).toBeNull();
    expect(addFrame).toBeNull();
    expect(transport).toBeTruthy();
    expect(transport?.getAttribute('data-frames')).toBe('2');
    expect(transport?.getAttribute('data-index')).toBe('1');
  });

  it('keeps the transport under its own gesture root', () => {
    // Load-bearing on Android: the speed slider is a GestureDetector, and this
    // sheet's content lives inside a Compose ModalBottomSheet the app's single
    // root GestureHandlerRootView does not cover (#4320).
    const { container, transport } = renderSlot({ frameCount: 2 });
    const gestureRoot = container.querySelector('[data-node="gesture-root"]');

    expect(gestureRoot).toBeTruthy();
    expect(gestureRoot?.contains(transport)).toBe(true);
  });
});
