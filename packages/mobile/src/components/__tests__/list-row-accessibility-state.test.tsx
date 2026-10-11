// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CapturedAccessibilityState = { busy?: boolean; disabled?: boolean; selected?: boolean };
type PressableCapture = {
  accessibilityState?: CapturedAccessibilityState;
  children?: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
};

const capturedPressable = vi.hoisted(() => ({ props: null as PressableCapture | null }));
const haptics = vi.hoisted(() => ({ light: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../PressableSurface', () => ({
  PressableSurface: (props: PressableCapture) => {
    capturedPressable.props = props;
    return createElement('button', null, props.children);
  },
}));
vi.mock('../../lib/haptics', () => ({ hapticLight: haptics.light }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { separator: '#ccc' } }),
}));

import { ListRow } from '../ListRow';

describe('ListRow accessibility state and disabled behavior', () => {
  beforeEach(() => {
    capturedPressable.props = null;
    haptics.light.mockReset();
  });

  it('preserves caller busy and selected state when the row is enabled', () => {
    const onPress = vi.fn();
    const accessibilityState = { busy: true, selected: true, disabled: false };
    render(createElement(ListRow, { title: 'Playlist', onPress, accessibilityState }));

    expect(capturedPressable.props?.disabled).toBe(false);
    expect(capturedPressable.props?.accessibilityState).toEqual(accessibilityState);
    capturedPressable.props?.onPress?.();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptics.light).toHaveBeenCalledTimes(1);
  });

  it('adds disabled state without dropping caller state and suppresses press and haptic', () => {
    const onPress = vi.fn();
    render(
      createElement(ListRow, {
        title: 'Playlist',
        onPress,
        disabled: true,
        accessibilityState: { busy: true, selected: true, disabled: false },
      }),
    );

    expect(capturedPressable.props?.disabled).toBe(true);
    expect(capturedPressable.props?.accessibilityState).toEqual({ busy: true, selected: true, disabled: true });
    capturedPressable.props?.onPress?.();
    expect(onPress).not.toHaveBeenCalled();
    expect(haptics.light).not.toHaveBeenCalled();
  });
});
