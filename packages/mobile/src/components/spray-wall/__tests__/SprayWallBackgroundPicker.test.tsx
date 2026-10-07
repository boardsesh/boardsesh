// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type A11yState = { disabled?: boolean; selected?: boolean };

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  Platform: { OS: 'ios', select: (choices: { ios: unknown }) => choices.ios },
  PlatformColor: (color: string) => color,
  View: ({
    children,
    testID,
    pointerEvents,
    accessibilityState,
    onLayout,
  }: {
    children?: ReactNode;
    testID?: string;
    pointerEvents?: string;
    accessibilityState?: A11yState;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  }) => {
    // The tile row measures itself; jsdom has no layout, so say 360 wide once.
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 360, height: 120 } } });
    }, [onLayout]);
    return createElement(
      'div',
      { 'data-testid': testID, 'data-pointer-events': pointerEvents, 'aria-disabled': accessibilityState?.disabled },
      children,
    );
  },
  Pressable: ({
    children,
    testID,
    onPress,
    disabled,
    accessibilityState,
    accessibilityLabel,
    accessibilityHint,
  }: {
    children?: ReactNode;
    testID?: string;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityState?: A11yState;
    accessibilityLabel?: string;
    accessibilityHint?: string;
  }) =>
    createElement(
      'button',
      {
        'data-testid': testID,
        // Like a real Pressable, a disabled one swallows the press.
        onClick: disabled ? undefined : onPress,
        'aria-disabled': accessibilityState?.disabled,
        'aria-selected': accessibilityState?.selected,
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
      },
      children,
    ),
}));
vi.mock('expo-image', () => ({
  Image: ({ cachePolicy, testID, source }: { cachePolicy?: string; testID?: string; source?: { uri: string } }) =>
    createElement('img', { 'data-testid': testID ?? 'image', 'data-cache-policy': cachePolicy, src: source?.uri }),
}));
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('svg', null, children),
  Path: ({ d }: { d: string }) => createElement('path', { d, 'data-testid': 'mask-path' }),
}));
vi.mock('@react-native-masked-view/masked-view', () => ({
  default: ({ children, maskElement }: { children?: ReactNode; maskElement?: ReactNode }) =>
    createElement('div', { 'data-testid': 'masked-view' }, maskElement, children),
}));
vi.mock('../FlattenedSprayPhoto', () => ({
  FlattenedSprayPhoto: ({ tile }: { tile: { width: number; height: number } }) =>
    createElement('div', { 'data-testid': 'flattened', 'data-tile': `${tile.width}x${tile.height}` }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { look?: string }) => (options?.look ? `${key}:${options.look}` : key),
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888', secondaryBackground: '#eee', label: '#000', accent: '#07f' },
  }),
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
  cutout: { url: 'https://private.example/cutout', thumbUrl: 'https://private.example/cutout-t', expiresAt: 'later' },
};

const SOURCE = {
  photoUrl: 'https://private.example/photo.jpg',
  photo: { width: 2400, height: 1800 },
  homography: [1, 0, -100, 0, 1, -100, 0, 0, 1],
  frame: { width: 2000, height: 1500 },
  holds: [
    { cx: 400, cy: 400, r: 40, outline: null },
    { cx: 1200, cy: 900, r: 60, outline: null },
  ],
};

const OPEN = { kind: 'open', soft: false, status: 'none' } as const;

afterEach(cleanup);

describe('SprayWallBackgroundPicker', () => {
  it('draws every look on the phone for a draft, and says so', () => {
    const { getByTestId, getAllByTestId } = render(
      <SprayWallBackgroundPicker
        gate={OPEN}
        art={null}
        value="wall-crop"
        onChange={vi.fn()}
        isDraft
        previewSource={SOURCE}
      />,
    );
    // Wall only and Holds only are both flattened live, at the same tile size.
    const flattened = getAllByTestId('flattened');
    expect(flattened).toHaveLength(2);
    // (360 - 2 gaps of 8) / 3 - 2 ring each side = 110.67, floored; 83 tall at the frame's 4:3.
    expect(flattened.map((node) => node.getAttribute('data-tile'))).toEqual(['110x83', '110x83']);
    expect(getByTestId('masked-view')).toBeTruthy();
    // One path for every hold, hard edge and feather: two elements however many holds.
    expect(getAllByTestId('mask-path')).toHaveLength(2);
    expect(getByTestId('spray-background-note-preview')).toBeTruthy();
    // The photo tile is the photo, memory-cached.
    const photo = getByTestId('spray-background-tile-visual-photo').querySelector('img');
    expect(photo?.getAttribute('src')).toBe(SOURCE.photoUrl);
    expect(photo?.getAttribute('data-cache-policy')).toBe('memory');
  });

  it('marks the chosen tile selected, and a tap on another picks it', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <SprayWallBackgroundPicker gate={OPEN} art={null} value="photo" onChange={onChange} previewSource={SOURCE} />,
    );
    expect(getByTestId('spray-background-tile-photo').getAttribute('aria-selected')).toBe('true');
    expect(getByTestId('spray-background-tile-wall-crop').getAttribute('aria-selected')).toBe('false');
    expect(getByTestId('spray-background-tile-wall-crop').getAttribute('aria-label')).toBe(
      'sprayBackground.previewLabel:sprayBackground.wallCrop',
    );
    fireEvent.click(getByTestId('spray-background-tile-hold-cutouts'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('hold-cutouts');
  });

  it('shows the stored art on a live wall once it is ready, out of the disk cache', () => {
    const { getByTestId, queryAllByTestId } = render(
      <SprayWallBackgroundPicker
        gate={{ kind: 'open', soft: false, status: 'ready' }}
        art={READY_ART}
        value="wall-crop"
        onChange={vi.fn()}
        previewSource={SOURCE}
      />,
    );
    expect(queryAllByTestId('flattened')).toHaveLength(0);
    const crop = getByTestId('spray-background-stored-wall-crop');
    expect(crop.getAttribute('src')).toBe('https://private.example/crop-t');
    expect(crop.getAttribute('data-cache-policy')).toBe('memory');
    expect(getByTestId('spray-background-stored-hold-cutouts').getAttribute('src')).toBe(
      'https://private.example/cutout-t',
    );
  });

  it('draws the live preview on a live wall whose art is still coming', () => {
    const { getAllByTestId, getByTestId } = render(
      <SprayWallBackgroundPicker
        gate={{ kind: 'open', soft: false, status: 'pending' }}
        art={null}
        value="wall-crop"
        onChange={vi.fn()}
        previewSource={SOURCE}
      />,
    );
    expect(getAllByTestId('flattened')).toHaveLength(2);
    expect(getByTestId('spray-background-note-generating')).toBeTruthy();
  });

  it('greys out the generated looks on a locked gate, with the reason, and the way out', () => {
    const onChange = vi.fn();
    const onRetakePhoto = vi.fn();
    const { getByTestId, getByText, queryAllByTestId } = render(
      <SprayWallBackgroundPicker
        gate={{ kind: 'locked', reason: 'no-pins' }}
        art={null}
        value="photo"
        onChange={onChange}
        onRetakePhoto={onRetakePhoto}
        previewSource={SOURCE}
      />,
    );
    for (const look of ['wall-crop', 'hold-cutouts']) {
      const tile = getByTestId(`spray-background-tile-${look}`);
      expect(tile.getAttribute('aria-disabled')).toBe('true');
      expect(tile.getAttribute('data-hint')).toBe('sprayBackground.note.lockedNoPins');
      fireEvent.click(tile);
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(queryAllByTestId('flattened')).toHaveLength(0);
    expect(getByTestId('spray-background-tile-photo').getAttribute('aria-disabled')).toBe('false');
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

  it('holds every tile still, and says it is disabled, while saving', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <SprayWallBackgroundPicker gate={OPEN} art={null} value="wall-crop" onChange={onChange} disabled />,
    );
    const control = getByTestId('spray-background-control');
    expect(control.getAttribute('data-pointer-events')).toBe('none');
    expect(control.getAttribute('aria-disabled')).toBe('true');
    for (const look of ['photo', 'wall-crop', 'hold-cutouts']) {
      const tile = getByTestId(`spray-background-tile-${look}`);
      expect(tile.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(tile);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('takes taps when open and idle', () => {
    const { getByTestId } = render(
      <SprayWallBackgroundPicker gate={OPEN} art={null} value="photo" onChange={vi.fn()} />,
    );
    const control = getByTestId('spray-background-control');
    expect(control.getAttribute('data-pointer-events')).toBe('auto');
    expect(control.getAttribute('aria-disabled')).toBe('false');
  });

  it('tells a Holds-only pick about volumes', () => {
    const { getByTestId } = render(
      <SprayWallBackgroundPicker gate={OPEN} art={null} value="hold-cutouts" onChange={vi.fn()} isDraft />,
    );
    expect(getByTestId('spray-background-note-volumes')).toBeTruthy();
  });

  it('draws nothing while the gate is unknown or unsupported', () => {
    const { container } = render(
      <SprayWallBackgroundPicker gate={{ kind: 'unsupported' }} art={null} value="photo" onChange={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
