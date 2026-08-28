// @vitest-environment jsdom
// The recency ladder the wall-state chrome speaks, lifted out of the deleted
// PlayDrawerOnWallBanner. It reads board presence, so the cases that matter are
// the ones where presence and reality disagree: a climb stays LIT after its
// sender stops being the active BLE writer, and that gap is exactly what the
// "how long ago" label exists to say.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, type ContextType, type ReactNode } from 'react';

// t interpolates count so the compact label is assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => {
      if (key === 'mobile.boardPresence.litAgoNow') return 'now';
      if (key === 'mobile.boardPresence.litAgoMinutes') return `${opts?.count}m`;
      if (key === 'mobile.boardPresence.litAgoHours') return `${opts?.count}h`;
      if (key === 'mobile.boardPresence.litAgoDays') return `${opts?.count}d`;
      if (key === 'mobile.boardPresence.litAgoWeeks') return `${opts?.count}w`;
      return key;
    },
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
import { useWallDriver } from '../use-wall-driver';

function renderWithPresence(value: unknown) {
  return renderHook(() => useWallDriver(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(
        BoardPresenceCurrentContext.Provider,
        { value: value as ContextType<typeof BoardPresenceCurrentContext> },
        children,
      ),
  });
}

describe('useWallDriver', () => {
  it('reports no driver and no recency when the wall is free', () => {
    const { result } = renderHook(() => useWallDriver());

    expect(result.current.driver).toBeNull();
    expect(result.current.name).toBeNull();
    expect(result.current.litAgo).toBeNull();
  });

  it('leaves the recency label off while the driver is actively connected', () => {
    const { result } = renderWithPresence({
      currentClimb: { sentByDisplayName: 'Marco', sentByUserId: 'u1', sentAt: new Date().toISOString() },
      holder: { userId: 'u1', displayName: 'Marco', lastSentAt: new Date().toISOString() },
    });

    expect(result.current.name).toBe('Marco');
    // Null is load-bearing: it's what keeps the avatar's Bluetooth glyph up.
    expect(result.current.litAgo).toBeNull();
  });

  it('labels how long ago they lit it once the driver has dropped', () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    const { result } = renderWithPresence({
      // Their climb is still lit, but they're no longer the active holder.
      currentClimb: { sentByDisplayName: 'Marco', sentByUserId: 'u1', sentAt: thirtyMinAgo },
      holder: null,
    });

    expect(result.current.litAgo).toBe('30m');
    expect(result.current.name).toBe('Marco');
  });

  it('labels an idle holder too — a wall nobody has touched for hours is not "connected"', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const { result } = renderWithPresence({
      currentClimb: { sentByDisplayName: 'Marco', sentByUserId: 'u1', sentAt: threeHoursAgo },
      holder: { userId: 'u1', displayName: 'Marco', lastSentAt: threeHoursAgo },
    });

    expect(result.current.litAgo).toBe('3h');
  });

  it('keeps an anonymous sender nameless rather than inventing one', () => {
    const { result } = renderWithPresence({
      currentClimb: { sentByDisplayName: '   ', sentByUserId: null, sentAt: new Date().toISOString() },
      holder: null,
    });

    expect(result.current.name).toBeNull();
    expect(result.current.driver).not.toBeNull();
  });
});
