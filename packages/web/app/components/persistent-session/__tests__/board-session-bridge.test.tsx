/**
 * Pins the echo-suppression contract in `BoardSessionBridge`. When the
 * local user changes the angle, the angle selector pushes the URL
 * locally for instant feedback and fires `setSessionBoardPath`. The
 * server broadcasts `SessionBoardPathChanged` to every member —
 * including the originator. The bridge must NOT call `router.replace`
 * on that echo, otherwise the originator's URL replaces itself on
 * every angle change (back-button stack pollution at best, infinite
 * router loop with broken de-dup at worst).
 *
 * Inverting the `if (changedByParticipantId === participantId) return`
 * branch would still let the "remote driver changes angle" path work
 * but would silently break the originator case — easy to miss without
 * an explicit test.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import { render } from '@testing-library/react';
import type { BoardDetails, ParsedBoardRouteParameters } from '@/app/lib/types';
import type { SessionEvent } from '@boardsesh/shared-schema';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const mockReplace = vi.fn();
const mockPush = vi.fn();

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ replace: mockReplace, push: mockPush }),
}));

let mockPathname = '/kilter/8/25/28,29,26,27/40/list';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/app/lib/climb-session-cookie', () => ({
  getClimbSessionCookie: () => null, // no session cookie — skip the activation effect
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('@/app/lib/session-lifecycle-tracking', () => ({
  registerSessionStart: vi.fn(),
}));

// Capture the callback that BoardSessionBridge passes to
// `subscribeToSessionEvents`. Tests invoke it directly to simulate
// events arriving over the WebSocket subscription.
type SessionEventListener = (event: SessionEvent) => void;
const sessionEventListeners: SessionEventListener[] = [];

const mockParticipantId: { current: string | null } = { current: 'me' };

vi.mock('../persistent-session-context', () => ({
  usePersistentSessionState: () => ({
    activeSession: null,
    participantId: mockParticipantId.current,
  }),
  usePersistentSessionActions: () => ({
    activateSession: vi.fn(),
    subscribeToSessionEvents: (callback: SessionEventListener) => {
      sessionEventListeners.push(callback);
      return () => {
        const idx = sessionEventListeners.indexOf(callback);
        if (idx >= 0) sessionEventListeners.splice(idx, 1);
      };
    },
  }),
}));

const { default: BoardSessionBridge } = await import('../board-session-bridge');

function makeBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 8,
    size_id: 25,
    set_ids: [28, 29, 26, 27],
  } as BoardDetails;
}

function makeParsedParams(): ParsedBoardRouteParameters {
  return {
    board_name: 'kilter',
    layout_id: 8,
    size_id: 25,
    set_ids: [28, 29, 26, 27],
    angle: 40,
  };
}

function renderBridge() {
  return render(
    <BoardSessionBridge boardDetails={makeBoardDetails()} parsedParams={makeParsedParams()}>
      <div data-testid="bridge-children" />
    </BoardSessionBridge>,
  );
}

function emit(event: SessionEvent) {
  // Invoke every registered callback — mirrors the bridge's
  // subscription fan-out. Each render adds one listener (per the
  // subscribeToSessionEvents call in the effect); cleanup pops it.
  sessionEventListeners.forEach((fn) => fn(event));
}

describe('BoardSessionBridge — SessionBoardPathChanged echo suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionEventListeners.length = 0;
    mockPathname = '/kilter/8/25/28,29,26,27/40/list';
    mockParticipantId.current = 'me';
    window.history.replaceState({}, '', '/');
  });

  it('calls router.replace when a remote member changes the boardPath', () => {
    renderBridge();

    emit({
      __typename: 'SessionBoardPathChanged',
      boardPath: '/kilter/8/25/28,29,26,27/35/list',
      changedByParticipantId: 'someone-else',
    });

    expect(mockReplace).toHaveBeenCalledOnce();
    expect(mockReplace).toHaveBeenCalledWith('/kilter/8/25/28,29,26,27/35/list');
  });

  it('does NOT call router.replace when the originator is the local participant (echo suppression)', () => {
    renderBridge();

    emit({
      __typename: 'SessionBoardPathChanged',
      boardPath: '/kilter/8/25/28,29,26,27/35/list',
      changedByParticipantId: 'me', // same as participantId
    });

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('calls router.replace when changedByParticipantId is null (system-initiated update)', () => {
    // Schema field is nullable so system-driven updates skip the
    // echo-suppression branch and follow normally.
    renderBridge();

    emit({
      __typename: 'SessionBoardPathChanged',
      boardPath: '/kilter/8/25/28,29,26,27/35/list',
      changedByParticipantId: null,
    });

    expect(mockReplace).toHaveBeenCalledOnce();
  });

  it('preserves the receiver-side query string when replacing the URL', () => {
    window.history.replaceState({}, '', '/kilter/8/25/28,29,26,27/40/list?minGrade=10&onlyClassics=true');
    renderBridge();

    emit({
      __typename: 'SessionBoardPathChanged',
      boardPath: '/kilter/8/25/28,29,26,27/35/list',
      changedByParticipantId: 'someone-else',
    });

    expect(mockReplace).toHaveBeenCalledWith('/kilter/8/25/28,29,26,27/35/list?minGrade=10&onlyClassics=true');
  });

  it('ignores events for other types (WallDisconnected, UserJoined, etc.)', () => {
    renderBridge();

    emit({
      __typename: 'WallDisconnected',
      disconnectedByParticipantId: 'someone-else',
    } as SessionEvent);
    emit({
      __typename: 'UserJoined',
      user: { id: 'someone-else', username: 'Other', isLeader: false, avatarUrl: null },
    } as SessionEvent);

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not crash on a SessionBoardPathChanged event with missing boardPath (defensive guard)', () => {
    // The selection set lapse that the bridge guards against — event
    // arrives with __typename set but `boardPath` undefined. Calling
    // `router.replace(undefined)` would have crashed the locale router
    // and taken down every other subscriber on the same notify pass.
    renderBridge();

    expect(() =>
      emit({
        __typename: 'SessionBoardPathChanged',
        boardPath: undefined as unknown as string,
        changedByParticipantId: 'someone-else',
      } as SessionEvent),
    ).not.toThrow();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
