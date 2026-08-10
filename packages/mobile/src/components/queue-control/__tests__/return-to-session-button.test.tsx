// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const routerNavigate = vi.fn();

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: routerNavigate }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { live: '#FBBF24' } }),
}));

vi.mock('../../../theme/layout', () => ({ glassSize: { inline: 44 } }));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
  }) =>
    createElement('button', { onClick: onPress, role: accessibilityRole, 'aria-label': accessibilityLabel }, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-color': color ?? '' }),
}));

import { hapticLight } from '../../../lib/haptics';
import { ReturnToSessionButton } from '../ReturnToSessionButton';

describe('ReturnToSessionButton', () => {
  it('navigates to the Record tab and fires haptic feedback on press', () => {
    const { getByRole } = render(<ReturnToSessionButton />);
    fireEvent.click(getByRole('button'));
    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(routerNavigate).toHaveBeenCalledWith('/(tabs)/record');
  });

  it('resolves its accessibility label via i18n', () => {
    const { getByRole } = render(<ReturnToSessionButton />);
    expect(getByRole('button').getAttribute('aria-label')).toBe('mobile.session.returnToSession');
  });

  it('renders the record icon in the live brand color', () => {
    const { container } = render(<ReturnToSessionButton />);
    const icon = container.querySelector('[data-icon="record"]');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('data-color')).toBe('#FBBF24');
  });
});
