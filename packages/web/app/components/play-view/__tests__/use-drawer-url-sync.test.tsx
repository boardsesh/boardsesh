// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook } from '@testing-library/react';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { useDrawerUrlSync } from '../use-drawer-url-sync';

let mockPathname = '/kilter/original/12x12/default/40/list';
const mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}));

function makeBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    layout_name: 'original',
    size_id: 7,
    size_name: '12x12',
    size_description: undefined,
    set_ids: [1, 20],
    set_names: ['mainline'],
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 0,
    boardWidth: 0,
    supportsMirroring: false,
  } as unknown as BoardDetails;
}

function makeClimb(uuid: string, name: string): Climb {
  return { uuid, name } as Climb;
}

const CLIMB_A = makeClimb('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'climb a');
const CLIMB_B = makeClimb('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'climb b');

// Capture the current URL on a settable location.pathname proxy so we can
// assert what pushState/replaceState wrote. Real jsdom updates the URL when
// the test calls history.pushState, so we just read window.location after.
function getPath(): string {
  return window.location.pathname;
}
function setLocation(path: string) {
  window.history.replaceState(null, '', path);
}

let onClose: () => void;
let onCloseMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockPathname = '/kilter/original/12x12/default/40/list';
  setLocation('/kilter/original/12x12/default/40/list');
  onCloseMock = vi.fn();
  onClose = onCloseMock as unknown as () => void;
});

type HookProps = { isOpen: boolean; climb: Climb | null };
const initialClosed: HookProps = { isOpen: false, climb: null };

describe('useDrawerUrlSync — list-tap flow', () => {
  it('pushes the view URL when the drawer opens with a climb on a list pathname', () => {
    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: initialClosed },
    );

    rerender({ isOpen: true, climb: CLIMB_A });

    expect(getPath()).toContain('/view/');
    expect(getPath()).toContain(CLIMB_A.uuid);
  });

  it('replaces the view URL when the displayed climb changes (swipe / row-tap while open)', () => {
    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: initialClosed },
    );

    rerender({ isOpen: true, climb: CLIMB_A });
    const pushedLength = window.history.length;

    rerender({ isOpen: true, climb: CLIMB_B });

    expect(getPath()).toContain(CLIMB_B.uuid);
    // replaceState should not grow the history stack — push grew it once,
    // every subsequent climb change should keep it flat.
    expect(window.history.length).toBe(pushedLength);
  });

  it('replaceStates to the list URL when the drawer closes (sync, race-free)', () => {
    const backSpy = vi.spyOn(window.history, 'back');
    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: initialClosed },
    );

    rerender({ isOpen: true, climb: CLIMB_A });
    expect(getPath()).toContain('/view/');

    rerender({ isOpen: false, climb: CLIMB_A });

    // Synchronous URL change — history.back() is async per spec, so we use
    // replaceState to keep the close race-free.
    expect(getPath()).not.toContain('/view/');
    expect(backSpy).not.toHaveBeenCalled();
    backSpy.mockRestore();
  });

  it('closes onto the qualified size slug for a shadowed size (id-aware, not name-based)', () => {
    // Kilter layout 1 size 27 shares its name-derived slug with size 10; the
    // close URL must come from the ids or every drawer close would rewrite the
    // address bar onto the other physical board.
    const shadowedBoardDetails = {
      ...makeBoardDetails(),
      size_id: 27,
      size_name: '12 x 12 without kickboard',
      size_description: 'Square',
    } as BoardDetails;
    mockPathname = '/kilter/original/12x12-square-without-kickboard/screw_bolt/40/list';
    setLocation(mockPathname);

    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: shadowedBoardDetails,
          angle: 40,
          onClose,
        }),
      { initialProps: initialClosed },
    );

    rerender({ isOpen: true, climb: CLIMB_A });
    rerender({ isOpen: false, climb: CLIMB_A });

    expect(getPath()).toBe('/kilter/original/12x12-square-without-kickboard/screw_bolt/40/list');
  });
});

describe('useDrawerUrlSync — enabled=false', () => {
  it('is fully inert when enabled is false (wall-view mode peek gesture)', () => {
    const before = window.history.length;
    const startPath = getPath();
    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
          enabled: false,
        }),
      { initialProps: initialClosed },
    );

    rerender({ isOpen: true, climb: CLIMB_A });
    rerender({ isOpen: true, climb: CLIMB_B });
    rerender({ isOpen: false, climb: CLIMB_B });

    // URL and history must be untouched across the full open → swipe → close cycle.
    expect(getPath()).toBe(startPath);
    expect(window.history.length).toBe(before);

    // popstate while disabled must not invoke onClose either.
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(onCloseMock).not.toHaveBeenCalled();
  });
});

describe('useDrawerUrlSync — direct-hit flow', () => {
  beforeEach(() => {
    mockPathname = '/kilter/original/12x12/default/40/view/climb-a-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    setLocation(mockPathname);
  });

  it('replaces (not pushes) when the drawer opens already on /view/', () => {
    const before = window.history.length;
    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: initialClosed },
    );

    rerender({ isOpen: true, climb: CLIMB_A });

    expect(getPath()).toContain('/view/');
    expect(window.history.length).toBe(before);
  });

  it('replaces (not history.back()) when closing from a direct-hit', () => {
    const before = window.history.length;
    const backSpy = vi.spyOn(window.history, 'back');
    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: { isOpen: true, climb: CLIMB_A } as HookProps },
    );

    rerender({ isOpen: false, climb: CLIMB_A });

    expect(backSpy).not.toHaveBeenCalled();
    expect(getPath()).not.toContain('/view/');
    expect(window.history.length).toBe(before);
    backSpy.mockRestore();
  });
});

describe('useDrawerUrlSync — popstate', () => {
  it('calls onClose when popstate fires and the URL leaves /view/', () => {
    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: initialClosed },
    );

    rerender({ isOpen: true, climb: CLIMB_A });
    expect(getPath()).toContain('/view/');

    // Simulate the user pressing browser back: URL leaves /view/, then
    // dispatch popstate. The listener should call onClose.
    setLocation('/kilter/original/12x12/default/40/list');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when popstate fires and the URL still contains /view/', () => {
    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: initialClosed },
    );

    rerender({ isOpen: true, climb: CLIMB_A });

    // popstate fires (e.g. iOS swipe-back into another /view/ URL) but we're
    // still on /view/ — drawer should stay open.
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(onCloseMock).not.toHaveBeenCalled();
  });
});

describe('useDrawerUrlSync — close-then-reopen race', () => {
  it('keeps the URL on /view/ when the drawer is closed and reopened in quick succession', () => {
    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: initialClosed },
    );

    rerender({ isOpen: true, climb: CLIMB_A });
    expect(getPath()).toContain('/view/');

    // Close, then reopen — the close cleanup must not asynchronously undo
    // the fresh push from the reopen.
    rerender({ isOpen: false, climb: CLIMB_A });
    rerender({ isOpen: true, climb: CLIMB_A });

    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(getPath()).toContain('/view/');
        expect(getPath()).toContain(CLIMB_A.uuid);
        resolve();
      }, 0),
    );
  });
});

describe('useDrawerUrlSync — locale prefix', () => {
  it('preserves the locale prefix when closing from a canonical /es/ view URL', () => {
    mockPathname = '/es/kilter/original/12x12/default/40/view/climb-a-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    setLocation(mockPathname);

    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: { isOpen: true, climb: CLIMB_A } as HookProps },
    );

    rerender({ isOpen: false, climb: CLIMB_A });

    expect(getPath()).toMatch(/^\/es\//);
    expect(getPath()).not.toContain('/view/');
  });

  it('preserves the locale prefix on /es/b/{slug}/ short routes too', () => {
    mockPathname = '/es/b/some-board/40/view/climb-a-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    setLocation(mockPathname);

    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: { isOpen: true, climb: CLIMB_A } as HookProps },
    );

    rerender({ isOpen: false, climb: CLIMB_A });

    expect(getPath()).toBe('/es/b/some-board/40/list');
  });
});

describe('useDrawerUrlSync — bridge-lag race', () => {
  it('pushes the URL once displayedClimb arrives, even if isOpen flipped a render earlier', () => {
    const { rerender } = renderHook(
      ({ isOpen, climb }: { isOpen: boolean; climb: Climb | null }) =>
        useDrawerUrlSync({
          isOpen,
          displayedClimb: climb,
          boardDetails: makeBoardDetails(),
          angle: 40,
          onClose,
        }),
      { initialProps: initialClosed },
    );

    // Solo /b/ tap: isOpen flips true in render N+1 but the queue bridge
    // hasn't propagated the climb yet — displayedClimb is still null.
    rerender({ isOpen: true, climb: null });
    expect(getPath()).not.toContain('/view/');

    // Bridge propagates in render N+2 — climb arrives, hook should push now.
    rerender({ isOpen: true, climb: CLIMB_A });

    expect(getPath()).toContain('/view/');
    expect(getPath()).toContain(CLIMB_A.uuid);
  });
});
