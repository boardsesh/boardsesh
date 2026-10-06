// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios', select: (choices: { ios: unknown }) => choices.ios },
  PlatformColor: (color: string) => color,
  View: ({
    children,
    testID,
    pointerEvents,
    accessibilityState,
    accessibilityElementsHidden,
  }: {
    children?: ReactNode;
    testID?: string;
    pointerEvents?: string;
    accessibilityState?: { disabled?: boolean };
    accessibilityElementsHidden?: boolean;
  }) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-pointer-events': pointerEvents,
        'aria-disabled': accessibilityState?.disabled,
        'data-a11y-hidden': accessibilityElementsHidden,
      },
      children,
    ),
}));
vi.mock('expo-image', () => ({
  Image: ({ cachePolicy, testID }: { cachePolicy?: string; testID?: string }) =>
    createElement('img', { 'data-testid': testID, 'data-cache-policy': cachePolicy }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({ selectedKey }: { selectedKey: string }) =>
    createElement('div', { 'data-testid': 'segmented', 'data-selected': selectedKey }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#888', secondaryBackground: '#eee' } }),
  useAppColorScheme: () => 'dark',
}));

const { SprayWallBackgroundPicker } = await import('../SprayWallBackgroundPicker');

const READY_ART = {
  versionNumber: 2,
  recipe: 1,
  status: 'READY' as const,
  width: 800,
  height: 1200,
  quality: { stretch: 1.2, verdict: 'GOOD' as const, reason: 'ok', frameShortEdge: 2000 },
  crop: { url: 'https://private.example/crop', thumbUrl: 'https://private.example/crop-t', expiresAt: 'later' },
  cutout: null,
};

afterEach(cleanup);

describe('SprayWallBackgroundPicker', () => {
  it('draws no segmented control on a locked gate, only why and the way out', () => {
    const onChange = vi.fn();
    const onRetakePhoto = vi.fn();
    const { queryByTestId, getByTestId, getByText } = render(
      <SprayWallBackgroundPicker
        gate={{ kind: 'locked', reason: 'no-pins' }}
        art={null}
        value="photo"
        onChange={onChange}
        onRetakePhoto={onRetakePhoto}
      />,
    );
    expect(queryByTestId('segmented')).toBeNull();
    expect(getByTestId('spray-background-note-lockedNoPins')).toBeTruthy();
    fireEvent.click(getByText('sprayBackground.retake'));
    expect(onRetakePhoto).toHaveBeenCalledOnce();
  });

  it('offers the photo on a locked gate whose stored look no longer qualifies', () => {
    const onChange = vi.fn();
    const { getByText } = render(
      <SprayWallBackgroundPicker
        gate={{ kind: 'locked', reason: 'retake' }}
        art={null}
        value="wall-crop"
        onChange={onChange}
      />,
    );
    fireEvent.click(getByText('sprayBackground.usePhoto'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('photo');
  });

  it('holds the control still, and says it is disabled, while saving', () => {
    const { getByTestId } = render(
      <SprayWallBackgroundPicker
        gate={{ kind: 'open', soft: false, status: 'none' }}
        art={null}
        value="wall-crop"
        onChange={vi.fn()}
        disabled
      />,
    );
    const control = getByTestId('spray-background-control');
    expect(control.getAttribute('data-pointer-events')).toBe('none');
    expect(control.getAttribute('aria-disabled')).toBe('true');
  });

  it('takes taps when open and idle', () => {
    const { getByTestId } = render(
      <SprayWallBackgroundPicker
        gate={{ kind: 'open', soft: false, status: 'none' }}
        art={null}
        value="photo"
        onChange={vi.fn()}
      />,
    );
    const control = getByTestId('spray-background-control');
    expect(control.getAttribute('data-pointer-events')).toBe('auto');
    expect(control.getAttribute('aria-disabled')).toBe('false');
  });

  it('keeps a private wall preview out of the disk cache', () => {
    const { getByTestId } = render(
      <SprayWallBackgroundPicker
        gate={{ kind: 'open', soft: false, status: 'ready' }}
        art={READY_ART}
        value="wall-crop"
        onChange={vi.fn()}
      />,
    );
    expect(getByTestId('spray-background-preview').getAttribute('data-cache-policy')).toBe('memory');
  });
});
