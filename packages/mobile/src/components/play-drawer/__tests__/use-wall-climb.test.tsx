// @vitest-environment jsdom
// What the drawer is allowed to claim about the wall.
//
// Every piece of the wall-state chrome keys on DISPLAYED-EQUALS-WALL, so a read
// that answers "something is lit" when nothing is bound would put an "On the
// wall" pill over a dark board and arm a busy-wall confirm about a climb that
// isn't there. The cases below are the ones where presence data exists but does
// NOT mean the wall is lit for this climber.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, type ContextType, type ReactNode } from 'react';

const controls = vi.hoisted(() => ({ enabled: true, boardId: 7 as number | null }));

// A real context created inside the factory, so the test injects through the
// same instance the hook reads. The hook is deliberately NOT mocked here — the
// non-throwing `useContext` read is half of what this file measures.
vi.mock('@boardsesh/board-presence-react', async () => {
  const React = await import('react');
  return { BoardPresenceWallClimbContext: React.createContext<unknown>(undefined) };
});
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => controls,
}));

import { BoardPresenceWallClimbContext } from '@boardsesh/board-presence-react';
import { useWallClimb } from '../use-wall-climb';

const LIT = { climbUuid: 'climb-lit', name: 'Their Project', sentAt: '2026-08-21T10:00:00Z', seq: 4 };

function renderWithWallClimb(value: unknown) {
  return renderHook(() => useWallClimb(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(
        BoardPresenceWallClimbContext.Provider,
        { value: value as ContextType<typeof BoardPresenceWallClimbContext> },
        children,
      ),
  });
}

describe('useWallClimb', () => {
  it('reports the lit climb and its name', () => {
    controls.enabled = true;
    controls.boardId = 7;
    const { result } = renderWithWallClimb(LIT);

    expect(result.current).toEqual({ uuid: 'climb-lit', name: 'Their Project', sentAt: '2026-08-21T10:00:00Z' });
  });

  it('reports a dark wall when nothing is lit', () => {
    controls.enabled = true;
    controls.boardId = 7;
    const { result } = renderWithWallClimb(null);

    expect(result.current).toEqual({ uuid: null, name: null, sentAt: null });
  });

  it('reports a dark wall when no board is bound, even with a climb in the feed', () => {
    // A stale climb from a board this phone is no longer on is not "the wall" —
    // committing against it would ask a question about someone else's gym.
    controls.enabled = true;
    controls.boardId = null;
    const { result } = renderWithWallClimb(LIT);

    expect(result.current.uuid).toBeNull();
  });

  it('reports a dark wall when presence is disabled', () => {
    controls.enabled = false;
    controls.boardId = 7;
    const { result } = renderWithWallClimb(LIT);

    expect(result.current.uuid).toBeNull();
  });

  it('degrades instead of throwing outside the presence provider', () => {
    // The play drawer is a modal route and can render outside that subtree; the
    // shared `useBoardPresenceWallClimb()` throws there, which would take the
    // whole player down over a piece of chrome.
    controls.enabled = true;
    controls.boardId = 7;
    const { result } = renderHook(() => useWallClimb());

    expect(result.current).toEqual({ uuid: null, name: null, sentAt: null });
  });

  it('carries a nameless lit climb rather than dropping it', () => {
    // The uuid is what the confirm's arming predicate needs; a missing name only
    // costs the question its subject.
    controls.enabled = true;
    controls.boardId = 7;
    const { result } = renderWithWallClimb({ ...LIT, name: undefined });

    expect(result.current).toEqual({ uuid: 'climb-lit', name: null, sentAt: '2026-08-21T10:00:00Z' });
  });
});
