// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, type ContextType, type ReactNode } from 'react';

// A real context (created in the hoisted factory) so each test can inject a
// presence value via its Provider; imported back below to reach the instance.
vi.mock('@boardsesh/board-presence-react', async () => {
  const React = await import('react');
  return { BoardPresenceCurrentContext: React.createContext<unknown>(null) };
});

import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import { useBoardDriver } from '../use-board-driver';

const wrapperWith = (value: unknown) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      BoardPresenceCurrentContext.Provider,
      { value: value as ContextType<typeof BoardPresenceCurrentContext> },
      children,
    );
  };

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const FIFTEEN_MIN = 15 * 60_000;

describe('useBoardDriver', () => {
  it('returns null when there is no holder and no current climb', () => {
    const { result } = renderHook(() => useBoardDriver());
    expect(result.current).toBeNull();
  });

  it('resolves identity from the current climb even without an active holder', () => {
    const value = {
      currentClimb: {
        sentByUserId: 'u1',
        sentByDisplayName: 'Marco',
        sentByAvatarUrl: 'a.jpg',
        sentAt: isoAgo(60_000),
      },
      holder: null,
    };
    const { result } = renderHook(() => useBoardDriver(), { wrapper: wrapperWith(value) });
    expect(result.current).toMatchObject({
      userId: 'u1',
      displayName: 'Marco',
      avatarUrl: 'a.jpg',
      isHeld: false,
      isIdle: false,
    });
  });

  it('prefers the current climb identity over the holder, and marks isHeld when a holder exists', () => {
    const value = {
      currentClimb: { sentByUserId: 'u1', sentByDisplayName: 'Climb Sender', sentAt: isoAgo(60_000) },
      holder: { userId: 'u2', displayName: 'Holder', avatarUrl: 'h.jpg', lastSentAt: isoAgo(60_000) },
    };
    const { result } = renderHook(() => useBoardDriver(), { wrapper: wrapperWith(value) });
    expect(result.current).toMatchObject({ userId: 'u1', displayName: 'Climb Sender', isHeld: true });
  });

  it('falls back to the holder record when there is no current climb', () => {
    const value = {
      currentClimb: null,
      holder: { userId: 'u2', displayName: 'Holder', avatarUrl: 'h.jpg', lastSentAt: isoAgo(60_000) },
    };
    const { result } = renderHook(() => useBoardDriver(), { wrapper: wrapperWith(value) });
    expect(result.current).toMatchObject({ userId: 'u2', displayName: 'Holder', isHeld: true, isIdle: false });
  });

  it('flags idle once the last send is older than the threshold', () => {
    const value = { currentClimb: { sentByDisplayName: 'Marco', sentAt: isoAgo(FIFTEEN_MIN + 60_000) }, holder: null };
    const { result } = renderHook(() => useBoardDriver(), { wrapper: wrapperWith(value) });
    expect(result.current?.isIdle).toBe(true);
  });

  it('reports lastSentAtMs null (and not idle) when the timestamp is missing', () => {
    const value = { currentClimb: { sentByDisplayName: 'Marco' }, holder: { userId: 'u2', displayName: 'Holder' } };
    const { result } = renderHook(() => useBoardDriver(), { wrapper: wrapperWith(value) });
    expect(result.current?.lastSentAtMs).toBeNull();
    expect(result.current?.isIdle).toBe(false);
  });
});
