// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({ push: vi.fn(), haptic: vi.fn() }));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: ctrl.push }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${String(opts.name)}` : key),
  }),
}));
vi.mock('../../lib/haptics', () => ({ hapticLight: ctrl.haptic }));
vi.mock('../Avatar', () => ({
  Avatar: ({ name, size }: { name?: string | null; size?: number }) =>
    createElement('div', { 'data-avatar': true, 'data-name': name ?? '', 'data-size': size }),
}));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({
    onPress,
    accessibilityLabel,
    accessibilityRole,
    children,
  }: {
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    children?: ReactNode;
  }) =>
    createElement(
      'button',
      { 'data-pressable': true, onClick: onPress, 'aria-label': accessibilityLabel, 'data-role': accessibilityRole },
      children,
    ),
}));

import { PressableAvatar } from '../PressableAvatar';

describe('PressableAvatar', () => {
  beforeEach(() => {
    ctrl.push.mockClear();
    ctrl.haptic.mockClear();
  });

  it('navigates to the climber profile (by id) and fires a haptic on press', () => {
    const { container } = render(<PressableAvatar userId="u1" name="Alex" uri={null} size={36} />);
    const button = container.querySelector('[data-pressable]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute('data-role')).toBe('button');
    // Label interpolates the name so VoiceOver reads "View Alex's profile".
    expect(button.getAttribute('aria-label')).toBe('mobile.avatar.viewProfile:Alex');

    fireEvent.click(button);
    expect(ctrl.haptic).toHaveBeenCalledTimes(1);
    expect(ctrl.push).toHaveBeenCalledWith({ pathname: '/users/[userId]', params: { userId: 'u1' } });
  });

  it('renders a plain, non-interactive avatar when no userId is given', () => {
    const { container } = render(<PressableAvatar name="Ghost" uri={null} size={32} />);
    expect(container.querySelector('[data-pressable]')).toBeNull();
    const avatar = container.querySelector('[data-avatar]');
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute('data-name')).toBe('Ghost');
  });
});
