// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Paper Appbar.Action → DOM node exposing the icon box size it was given, with
// the rendered icon inside so the avatar's own size is visible too.
vi.mock('react-native-paper', () => ({
  Appbar: {
    Action: ({ icon, size }: { icon: (props: { size: number; color: string }) => ReactNode; size?: number }) =>
      createElement('button', { 'data-icon-size': String(size ?? 24) }, icon({ size: size ?? 24, color: '#fff' })),
  },
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#fff', separator: '#333' } }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { displayName: 'Test User', email: null, avatarUrl: null } }),
}));
vi.mock('../../Avatar', () => ({
  Avatar: ({ size }: { size: number }) => createElement('span', { 'data-avatar-size': String(size) }),
}));
vi.mock('../../chrome/GlassActionToolbar', () => ({
  GlassToolbarAction: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  useToolbarActionCount: () => 1,
  useToolbarActionSize: () => 44,
}));
vi.mock('../UserDrawerProvider', () => ({ useUserDrawer: () => ({ openUserDrawer: () => {} }) }));

import { UserAvatarToolbarAction } from '../UserAvatarToolbarAction';

describe('UserAvatarToolbarAction (material)', () => {
  it('sizes the app bar icon box to the avatar so Paper does not clip it', () => {
    const { container } = render(createElement(UserAvatarToolbarAction, { variant: 'material' }));
    const button = container.querySelector('[data-icon-size]');
    const avatar = container.querySelector('[data-avatar-size]');
    expect(avatar?.getAttribute('data-avatar-size')).toBe('32');
    expect(button?.getAttribute('data-icon-size')).toBe(avatar?.getAttribute('data-avatar-size'));
  });
});
