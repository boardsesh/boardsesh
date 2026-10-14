// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { cleanup, render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type A11yState = { disabled?: boolean; selected?: boolean };

vi.mock('react-native', () => ({
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
    absoluteFill: {},
  },
  Platform: { OS: 'ios', select: (choices: { ios: unknown }) => choices.ios },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
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
  Image: ({
    cachePolicy,
    testID,
    source,
    style,
  }: {
    cachePolicy?: string;
    testID?: string;
    source?: { uri: string };
    style?: { width?: number; height?: number };
  }) =>
    createElement('img', {
      'data-testid': testID ?? 'image',
      'data-cache-policy': cachePolicy,
      'data-size': `${style?.width}x${style?.height}`,
      src: source?.uri,
    }),
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
  FlattenedSprayPhoto: ({ tile, photoUri }: { tile: { width: number; height: number }; photoUri: string }) =>
    createElement('div', {
      'data-testid': 'flattened',
      'data-tile': `${tile.width}x${tile.height}`,
      'data-uri': photoUri,
    }),
}));
const LOCAL_PHOTO = 'file:///cache/spray-walls/9-v3.jpg';
const photoCache = vi.hoisted(() => ({ onDisk: true }));
vi.mock('../../../lib/spray/use-spray-look-preview-photo', () => ({
  useSprayLookPreviewPhoto: (source: unknown) =>
    source && photoCache.onDisk ? 'file:///cache/spray-walls/9-v3.jpg' : null,
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
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888', secondaryBackground: '#eee', label: '#000', accent: '#07f' },
  }),
  useAppColorScheme: () => 'dark',
}));

const { SprayWallBackgroundPreview } = await import('../SprayWallBackgroundPreview');
const SOURCE = {
  layoutId: 9,
  versionId: 3,
  photoUrl: 'https://private.example/photo.jpg',
  photoExpiresAt: 'later',
  photo: { width: 2400, height: 1800 },
  homography: [1, 0, -100, 0, 1, -100, 0, 0, 1],
  frame: { width: 2000, height: 1600 },
  holds: [
    { cx: 400, cy: 400, r: 40, outline: null },
    { cx: 1200, cy: 900, r: 60, outline: null },
  ],
};

afterEach(() => {
  cleanup();
  photoCache.onDisk = true;
});

describe('wizard background preview', () => {
  it('draws the one selected background, fitted to its row, and swaps it when the choice moves', () => {
    const { getByTestId, queryByTestId, rerender, container } = render(
      <SprayWallBackgroundPreview value="wall-crop" previewSource={SOURCE} />,
    );
    expect(getByTestId('flattened').getAttribute('data-uri')).toBe(LOCAL_PHOTO);
    expect(getByTestId('flattened').getAttribute('data-tile')).toBe('150x120');
    expect(queryByTestId('spray-background-tile-visual-photo')).toBeNull();
    rerender(<SprayWallBackgroundPreview value="hold-cutouts" previewSource={SOURCE} />);
    expect(getByTestId('masked-view')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid^="spray-background-tile-visual-"]')).toHaveLength(1);
    rerender(<SprayWallBackgroundPreview value="photo" previewSource={SOURCE} />);
    expect(container.querySelector('img')?.getAttribute('data-cache-policy')).toBe('memory');
    expect(container.querySelector('img')?.getAttribute('data-size')).toBe('160x120');
    expect(container.innerHTML).not.toContain(SOURCE.photoUrl);
  });

  it('shows no endless spinner when the draft cannot be drawn', () => {
    const { queryByTestId } = render(<SprayWallBackgroundPreview value="photo" previewSource={null} unavailable />);
    expect(queryByTestId('spinner')).toBeNull();
  });
});
