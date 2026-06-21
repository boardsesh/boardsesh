// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ContextType, type ReactNode } from 'react';

// Animated.View just renders children; FadeIn is a no-op chainable.
vi.mock('react-native-reanimated', () => {
  const chain: Record<string, () => unknown> = {};
  chain.springify = () => chain;
  chain.damping = () => chain;
  chain.stiffness = () => chain;
  return {
    default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
    FadeIn: chain,
  };
});

// t interpolates name/count so the a11y label and the compact "how long ago"
// label are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string; count?: number }) => {
      if (key === 'mobile.boardPresence.drivenByA11y') return `${opts?.name} is lighting the wall. Open profile.`;
      if (key === 'mobile.boardPresence.drivenByAnonA11y') return 'Someone is lighting the wall.';
      if (key === 'mobile.boardPresence.litAgoNow') return 'now';
      if (key === 'mobile.boardPresence.litAgoMinutes') return `${opts?.count}m`;
      if (key === 'mobile.boardPresence.litAgoHours') return `${opts?.count}h`;
      if (key === 'mobile.boardPresence.litAgoDays') return `${opts?.count}d`;
      if (key === 'mobile.boardPresence.litAgoWeeks') return `${opts?.count}w`;
      return key;
    },
  }),
}));

// The avatar atom renders its props as data attributes so the banner's
// prop-passing (identity + corner content + a11y label) is assertable without
// the deep PressableAvatar / expo-router tree.
type DriverAvatarProps = {
  userId?: string | null;
  name?: string | null;
  status?: string;
  cornerLabel?: string | null;
  accessibilityLabel?: string;
};
vi.mock('../../board-presence/BoardDriverAvatar', () => ({
  BoardDriverAvatar: ({ userId, name, status, cornerLabel, accessibilityLabel }: DriverAvatarProps) =>
    createElement('div', {
      'data-driver-avatar': 'true',
      'data-user-id': userId ?? '',
      'data-name': name ?? '',
      'data-status': status,
      'data-corner-label': cornerLabel ?? '',
      'data-a11y': accessibilityLabel,
    }),
}));

// A real context (created inside the hoisted factory) so the test can inject a
// holder via its Provider; imported back below to reach the same instance. The
// useBoardDriver hook (not mocked) reads this same context.
vi.mock('@boardsesh/board-presence-react', async () => {
  const React = await import('react');
  return { BoardPresenceCurrentContext: React.createContext<unknown>(null) };
});

import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import { PlayDrawerOnWallBanner } from '../PlayDrawerOnWallBanner';

const driverAvatar = (container: HTMLElement) =>
  container.querySelector('[data-driver-avatar="true"]') as HTMLElement | null;

const renderWithPresence = (value: unknown) =>
  render(
    createElement(
      BoardPresenceCurrentContext.Provider,
      { value: value as ContextType<typeof BoardPresenceCurrentContext> },
      createElement(PlayDrawerOnWallBanner),
    ),
  );

describe('PlayDrawerOnWallBanner', () => {
  it('renders an anonymous, non-pressable avatar with the BLE corner badge when no holder is known', () => {
    const { container } = render(createElement(PlayDrawerOnWallBanner));
    const avatar = driverAvatar(container);

    expect(avatar).toBeTruthy();
    expect(avatar?.getAttribute('data-user-id')).toBe('');
    expect(avatar?.getAttribute('data-status')).toBe('connected');
    expect(avatar?.getAttribute('data-corner-label')).toBe('');
    expect(avatar?.getAttribute('data-a11y')).toBe('Someone is lighting the wall.');
  });

  it('keeps the BLE corner badge (no time) while the driver is actively connected', () => {
    const presenceValue = {
      currentClimb: { sentByDisplayName: 'Marco', sentByUserId: 'u1', sentAt: new Date().toISOString() },
      holder: { userId: 'u1', displayName: 'Marco', lastSentAt: new Date().toISOString() },
    };
    const { container } = renderWithPresence(presenceValue);
    const avatar = driverAvatar(container);

    expect(avatar?.getAttribute('data-name')).toBe('Marco');
    expect(avatar?.getAttribute('data-user-id')).toBe('u1');
    expect(avatar?.getAttribute('data-status')).toBe('connected');
    expect(avatar?.getAttribute('data-corner-label')).toBe('');
  });

  it('swaps the corner badge to "how long ago they lit it" once the driver has dropped', () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    const presenceValue = {
      // Their climb is still lit, but they're no longer the active holder.
      currentClimb: { sentByDisplayName: 'Marco', sentByUserId: 'u1', sentAt: thirtyMinAgo },
      holder: null,
    };
    const { container } = renderWithPresence(presenceValue);
    const avatar = driverAvatar(container);

    // Same corner slot the BLE glyph used; now carries the compact elapsed time.
    expect(avatar?.getAttribute('data-corner-label')).toBe('30m');
    expect(avatar?.getAttribute('data-name')).toBe('Marco');
  });

  it('renders no button text and no "Set active" — it is read-only status, not a promotable preview', () => {
    const { container } = render(createElement(PlayDrawerOnWallBanner));
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('playView.setActive');
  });
});
