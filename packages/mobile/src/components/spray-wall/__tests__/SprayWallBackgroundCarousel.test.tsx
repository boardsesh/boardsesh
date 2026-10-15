// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SprayBackgroundGate } from '../spray-background-gate';

const rail = vi.hoisted(() => ({ onSnap: undefined as ((index: number) => void) | undefined }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios: unknown }) => options.ios },
  PlatformColor: (color: string) => color,
  DynamicColorIOS: (colors: { light: string }) => colors.light,
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ width: 402, fontScale: 1 }),
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: unknown) => void }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 402, height: 450 } } });
    }, [onLayout]);
    return createElement('div', null, children);
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#fff', separator: '#eee' },
    brandColors: { primary: '#639' },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
    accessibilityState: { checked: boolean };
  }) =>
    createElement(
      'button',
      {
        role: 'radio',
        onClick: onPress,
        disabled,
        'aria-label': accessibilityLabel,
        'aria-checked': accessibilityState.checked,
      },
      children,
    ),
}));
vi.mock('../../SnapCarousel', () => ({
  SnapCarousel: ({
    data,
    renderItem,
    onSnapToIndex,
  }: {
    data: { key: string }[];
    renderItem: (entry: { item: { key: string } }) => ReactNode;
    onSnapToIndex?: (index: number) => void;
  }) => {
    rail.onSnap = onSnapToIndex;
    return createElement(
      'div',
      null,
      data.map((item) => createElement('div', { key: item.key }, renderItem({ item }))),
    );
  },
}));
vi.mock('../../board-look/RailIndexDots', () => ({ RailIndexDots: () => null }));
vi.mock('../../board-look/board-look-card-metrics', () => ({ RAIL_MIN_WIDTH: 132 }));
vi.mock('../SprayWallBackgroundPreview', () => ({
  SprayWallBackgroundPreview: ({ value }: { value: string }) =>
    createElement('div', { 'data-testid': `photo-${value}` }),
}));

import { SprayWallBackgroundCarousel } from '../SprayWallBackgroundCarousel';
afterEach(cleanup);

function renderPicker(gate: SprayBackgroundGate = { kind: 'open', soft: false, status: 'none' }, disabled = false) {
  const onChange = vi.fn();
  render(
    <SprayWallBackgroundCarousel
      gate={gate}
      value="wall-crop"
      previewSource={null}
      height={450}
      disabled={disabled}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe('SprayWallBackgroundCarousel', () => {
  it('shows all three actual backgrounds as labeled preview cards', () => {
    renderPicker();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    for (const background of ['photo', 'wall-crop', 'hold-cutouts']) {
      expect(screen.getByTestId(`photo-${background}`)).toBeTruthy();
    }
    expect(screen.getByRole('radio', { name: 'sprayBackground.wallCrop' }).getAttribute('aria-checked')).toBe('true');
  });

  it('selects the background reached by a swipe or a neighboring-card tap', () => {
    const onChange = renderPicker();
    act(() => rail.onSnap?.(2));
    expect(onChange).toHaveBeenLastCalledWith('hold-cutouts');
    fireEvent.click(screen.getByRole('radio', { name: 'sprayBackground.photo' }));
    expect(onChange).toHaveBeenLastCalledWith('photo');
    fireEvent.click(screen.getByRole('radio', { name: 'sprayBackground.wallCrop' }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it.each([{ kind: 'loading' }, { kind: 'unsupported' }, { kind: 'locked', reason: 'no-pins' }] as const)(
    'offers only the photo when the gate is %o',
    (gate) => {
      renderPicker(gate);
      expect(screen.getAllByRole('radio')).toHaveLength(1);
      expect(screen.getByRole('radio', { name: 'sprayBackground.photo' })).toBeTruthy();
    },
  );

  it('blocks both swipe selection and taps while saving', () => {
    const onChange = renderPicker({ kind: 'open', soft: false, status: 'none' }, true);
    expect(rail.onSnap).toBeUndefined();
    fireEvent.click(screen.getByRole('radio', { name: 'sprayBackground.photo' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
