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
import { cleanup, fireEvent, render } from '@testing-library/react';
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
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
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

const sliderState = vi.hoisted(() => ({ lastChange: null as null | ((id: string) => void) }));
vi.mock('../../LookOptionSlider', () => ({
  LookOptionSlider: ({
    options,
    value,
    onChange,
    disabled,
  }: {
    options: { id: string; label: string }[];
    value: string;
    onChange: (id: string) => void;
    disabled: boolean;
  }) => {
    sliderState.lastChange = onChange;
    return createElement(
      'div',
      { 'data-testid': 'slider', 'data-value': value, 'aria-disabled': disabled },
      options.map((option) =>
        createElement('button', { key: option.id, disabled, onClick: () => onChange(option.id) }, option.label),
      ),
    );
  },
}));
const { SprayWallBackgroundSlider } = await import('../SprayWallBackgroundSlider');
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

const OPEN = { kind: 'open', soft: false, status: 'none' } as const;

afterEach(() => {
  cleanup();
  photoCache.onDisk = true;
});

describe('wizard background slider', () => {
  it('shows one selected background and replaces its preview as the slider moves', () => {
    const onChange = vi.fn();
    const { getByTestId, getByText, queryByTestId, rerender, container } = render(
      <SprayWallBackgroundSlider gate={OPEN} value="wall-crop" onChange={onChange} previewSource={SOURCE} />,
    );
    expect(getByTestId('flattened').getAttribute('data-uri')).toBe(LOCAL_PHOTO);
    expect(getByTestId('flattened').getAttribute('data-tile')).toBe('150x120');
    expect(queryByTestId('spray-background-tile-visual-photo')).toBeNull();
    fireEvent.click(getByText('sprayBackground.holdCutouts'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('hold-cutouts');
    rerender(<SprayWallBackgroundSlider gate={OPEN} value="hold-cutouts" onChange={onChange} previewSource={SOURCE} />);
    expect(getByTestId('masked-view')).toBeTruthy();
    expect(getByText('sprayBackground.note.volumes')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid^="spray-background-tile-visual-"]')).toHaveLength(1);
    rerender(<SprayWallBackgroundSlider gate={OPEN} value="photo" onChange={onChange} previewSource={SOURCE} />);
    expect(container.querySelector('img')?.getAttribute('data-cache-policy')).toBe('memory');
    expect(container.querySelector('img')?.getAttribute('data-size')).toBe('160x120');
    expect(container.innerHTML).not.toContain(SOURCE.photoUrl);
  });

  it.each(['loading', 'unsupported', 'locked'] as const)(
    'offers photo only for %s, refusing stale generated callbacks',
    (kind) => {
      const gate = kind === 'locked' ? { kind, reason: 'no-pins' as const } : { kind };
      const onChange = vi.fn();
      const { getByTestId, queryByText } = render(
        <SprayWallBackgroundSlider gate={gate} value="wall-crop" onChange={onChange} previewSource={SOURCE} />,
      );
      expect(getByTestId('slider').getAttribute('data-value')).toBe('photo');
      expect(queryByText('sprayBackground.wallCrop')).toBeNull();
      expect(queryByText('sprayBackground.holdCutouts')).toBeNull();
      sliderState.lastChange?.('wall-crop');
      sliderState.lastChange?.('hold-cutouts');
      expect(onChange).not.toHaveBeenCalled();
      if (kind === 'loading') expect(getByTestId('slider').getAttribute('aria-disabled')).toBe('true');
    },
  );

  it('holds selection still while saving, including a delayed slider callback', () => {
    const onChange = vi.fn();
    render(<SprayWallBackgroundSlider gate={OPEN} value="photo" onChange={onChange} previewSource={SOURCE} disabled />);
    sliderState.lastChange?.('hold-cutouts');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a readable unavailable fallback without an endless loading spinner', () => {
    const { getByText, queryByTestId } = render(
      <SprayWallBackgroundSlider
        gate={{ kind: 'unsupported' }}
        value="photo"
        onChange={vi.fn()}
        previewSource={null}
        unavailable
      />,
    );
    expect(getByText('sprayWizard.look.unavailable')).toBeTruthy();
    expect(getByText('sprayWizard.background.unsupported')).toBeTruthy();
    expect(queryByTestId('spinner')).toBeNull();
  });
});
