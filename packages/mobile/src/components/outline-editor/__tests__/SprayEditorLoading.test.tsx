// @vitest-environment jsdom
//
// The hold editor's wait, which used to be a bare spinner on a blank screen
// (#5959). Three things are pinned here: the wait always carries a status line,
// a photo still on the phone stays on screen WITHOUT the scan band (the scan is
// over by then), and a read that is not running says so and offers a retry.
//
// `SprayScanPhoto` is rendered for real, so the `band` switch is exercised
// rather than assumed; only its leaf dependencies are stubbed.
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const announce = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: announce },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
}));
vi.mock('expo-image', () => ({
  Image: ({ source }: { source: { uri: string } }) => createElement('img', { src: source.uri, alt: 'wall' }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-reanimated', () => ({
  cancelAnimation: () => {},
  Easing: { linear: () => 0 },
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (initial: number) => ({ value: initial }),
  withRepeat: (animation: unknown) => animation,
  withTiming: (target: number) => target,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#000', label: '#fff', secondaryLabel: '#aaa' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  borderRadius: { xl: 20 },
  overlays: { photoDimScan: 'rgba(0, 0, 0, 0.4)' },
  spacing: { 2: 8, 3: 12, 4: 16 },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('i', { 'data-testid': 'spinner' }),
}));
vi.mock('../../GlassSurface', () => ({ GlassSurface: () => null }));
vi.mock('../SprayScanBand', () => ({
  SCAN_BAND_HEIGHT: 40,
  SprayScanBand: () => createElement('i', { 'data-testid': 'scan-band' }),
}));
// jsdom never lays anything out, so the frame is given a size here. Without one
// the photo and the band are both skipped and "no band" would prove nothing.
vi.mock('../use-spray-editor-layout', () => ({
  useSprayEditorLayout: () => ({ layout: 'phone', landscape: false }),
  sprayPhotoReservesBottom: () => true,
}));
vi.mock('../spray-photo-frame', () => ({
  SPRAY_BAR_GUTTER: 8,
  fitSprayPhoto: () => ({ width: 300, height: 400, slotHeight: 500 }),
}));

import { SprayEditorLoading } from '../SprayEditorLoading';
import { SprayScanPhoto } from '../../spray-wall/SprayScanPhoto';

const PHOTO = { uri: 'file:///wall.jpg', width: 1536, height: 2048 };

beforeEach(() => {
  announce.mockClear();
});

describe('SprayEditorLoading', () => {
  it('announces a stall once when it starts, and never announces the plain wait', () => {
    // `accessibilityLiveRegion` is Android-only, so VoiceOver hears this or nothing.
    const onRetry = () => {};
    const { rerender } = render(<SprayEditorLoading photo={null} stalled={false} onRetry={onRetry} />);
    expect(announce).not.toHaveBeenCalled();

    rerender(<SprayEditorLoading photo={null} stalled onRetry={onRetry} />);
    rerender(<SprayEditorLoading photo={null} stalled onRetry={onRetry} />);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('sprayEditor.loadStalled');
  });

  it('keeps the photo on screen with a status line and no scan band', () => {
    render(<SprayEditorLoading photo={PHOTO} stalled={false} onRetry={() => {}} />);

    expect(screen.getByAltText('wall').getAttribute('src')).toBe(PHOTO.uri);
    expect(screen.getByText('sprayEditor.loading')).toBeTruthy();
    expect(screen.getByTestId('spinner')).toBeTruthy();
    expect(screen.queryByTestId('scan-band')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a spinner and a status line when there is no photo on the phone', () => {
    render(<SprayEditorLoading photo={null} stalled={false} onRetry={() => {}} />);

    expect(screen.getByTestId('spinner')).toBeTruthy();
    expect(screen.getByText('sprayEditor.loading')).toBeTruthy();
    expect(screen.queryByAltText('wall')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['with the photo', PHOTO],
    ['without a photo', null],
  ])('says a stalled read out loud and retries on tap, %s', (_label, photo) => {
    const onRetry = vi.fn();
    render(<SprayEditorLoading photo={photo} stalled onRetry={onRetry} />);

    expect(screen.getByText('sprayEditor.loadStalled')).toBeTruthy();
    expect(screen.queryByText('sprayEditor.loading')).toBeNull();
    // Nothing is running, so nothing spins.
    expect(screen.queryByTestId('spinner')).toBeNull();
    expect(screen.queryByTestId('scan-band')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'sprayDetection.retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('SprayScanPhoto', () => {
  it('still sweeps the band on the detect step, where nothing passes `band`', () => {
    render(<SprayScanPhoto photo={PHOTO} message="scanning" failed={false} />);

    expect(screen.getByTestId('scan-band')).toBeTruthy();
    // The card's spinner is the Reduce Motion stand-in for the band, not an extra.
    expect(screen.queryByTestId('spinner')).toBeNull();
  });
});
