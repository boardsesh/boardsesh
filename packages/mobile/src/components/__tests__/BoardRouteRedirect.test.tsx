// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { BoardRouteTarget } from '../../lib/routing/board-route-target';
import type { Climb } from '@boardsesh/shared-schema';
import type { BoardRouteStatus } from '../../lib/routing/use-board-route-target';

// What the gate hands back, as a sentinel. This suite asserts the component
// forwards that value VERBATIM; whether the value itself is right for a given
// location is `anonymous-auth-gate.web.test.ts`'s job.
const LOGIN_HREF = vi.hoisted(() => '/auth/login?next=%2Fb%2Fthe-gym%2F40%2Flist');

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const routeStatus = vi.hoisted(() => ({ current: 'resolving' as BoardRouteStatus }));
// The kill switch, as the component reads it. `true` = feature on.
const anonymousClimbView = vi.hoisted(() => ({ enabled: true, seen: [] as (boolean | undefined)[] }));
// What the anonymous branch renders instead of a redirect.
const anonymousView = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
// The resolved board's tilt setting, and whether the climb has landed yet.
const anonymousResult = vi.hoisted(() => ({ isAngleAdjustable: true, climbHasLanded: true }));
const redirect = vi.hoisted(() => ({ hrefs: [] as string[] }));
const router = vi.hoisted(() => ({ replace: vi.fn() }));
// The hand-off callback the hook holds. A successful hand-off never becomes a
// status — the real hook navigates the screen away in the same batch — so this
// is the only handle a test has on the `resolved` leg.
const handoff = vi.hoisted(() => ({ current: null as (() => void) | null }));
// Whatever `onlineManager` reports when the not-found lands. An offline
// not-found is the transient state a reconnect heals, not a dead link.
const connectivity = vi.hoisted(() => ({ isOnline: true }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => router,
  Redirect: ({ href }: { href: string }) => {
    redirect.hrefs.push(href);
    return null;
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { secondaryLabel: '#888' } }) }));

vi.mock('../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../Icon', () => ({ Icon: () => createElement('div', { 'data-testid': 'error-icon' }) }));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { 'data-testid': 'back-home', onClick: onPress }, title),
}));

vi.mock('../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../lib/routing/anonymous-auth-gate', () => ({
  buildLoginHrefWithReturn: () => LOGIN_HREF,
}));
vi.mock('@tanstack/react-query', () => ({ onlineManager: { isOnline: () => connectivity.isOnline } }));
vi.mock('../../providers/feature-flags-provider', () => ({
  useAnonymousClimbViewEnabled: () => anonymousClimbView.enabled,
}));
vi.mock('../AnonymousClimbView', () => ({
  AnonymousClimbView: (props: Record<string, unknown>) => {
    anonymousView.props.push(props);
    return createElement('div', { 'data-testid': 'anonymous-climb-view' });
  },
}));
vi.mock('../../lib/routing/use-board-route-target', () => ({
  useBoardRouteTarget: (_target: unknown, options?: { onHandedOff?: () => void; anonymousClimbEnabled?: boolean }) => {
    handoff.current = options?.onHandedOff ?? null;
    anonymousClimbView.seen.push(options?.anonymousClimbEnabled);
    return routeStatus.current === 'anonymous-climb' && anonymousResult.climbHasLanded
      ? {
          status: routeStatus.current,
          climb: ANONYMOUS_CLIMB,
          boardConfig: ANONYMOUS_BOARD_CONFIG,
          isAngleAdjustable: anonymousResult.isAngleAdjustable,
        }
      : { status: routeStatus.current, climb: null, boardConfig: null, isAngleAdjustable: true };
  },
}));

const ANONYMOUS_CLIMB = { uuid: '0A1B2C3D4E5F60718293A4B5C6D7E8F9', name: 'Crimpy Thing' } as unknown as Climb;
const ANONYMOUS_BOARD_CONFIG = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

const { BoardRouteHandoff, BoardRouteRedirect } = await import('../BoardRouteRedirect');

const CLIMB_TARGET = {
  kind: 'climb',
  board: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 },
  climbUuid: '0A1B2C3D4E5F60718293A4B5C6D7E8F9',
} as BoardRouteTarget;
const SLUG_CLIMB_TARGET = {
  kind: 'slug-climb',
  slug: 'the-gym',
  angle: 40,
  climbUuid: '0A1B2C3D4E5F60718293A4B5C6D7E8F9',
} as BoardRouteTarget;

beforeEach(() => {
  vi.clearAllMocks();
  redirect.hrefs = [];
  routeStatus.current = 'resolving';
  handoff.current = null;
  connectivity.isOnline = true;
  anonymousClimbView.enabled = true;
  anonymousClimbView.seen = [];
  anonymousView.props = [];
  anonymousResult.isAngleAdjustable = true;
  anonymousResult.climbHasLanded = true;
});

describe('BoardRouteRedirect', () => {
  // A handed-off screen keeps this spinner on its way out. Flashing the
  // not-found would read as a broken link for a link that worked.
  it('draws the spinner while resolving', () => {
    const { queryByTestId } = render(createElement(BoardRouteRedirect, { status: 'resolving' as BoardRouteStatus }));

    expect(queryByTestId('spinner')).not.toBeNull();
    expect(queryByTestId('error-icon')).toBeNull();
    expect(redirect.hrefs).toEqual([]);
  });

  it('draws the dead end at not-found', () => {
    const { queryByTestId } = render(createElement(BoardRouteRedirect, { status: 'not-found' as BoardRouteStatus }));

    expect(queryByTestId('error-icon')).not.toBeNull();
    expect(queryByTestId('back-home')).not.toBeNull();
    expect(queryByTestId('spinner')).toBeNull();
  });

  // Web only in practice: the signed-out visitor goes to login carrying the path
  // so the climb survives the round trip. The claim under test is that the
  // component forwards the gate's href unchanged — it must not rebuild one.
  it('redirects to the login href the gate hands back at auth-required', () => {
    const { queryByTestId } = render(
      createElement(BoardRouteRedirect, { status: 'auth-required' as BoardRouteStatus }),
    );

    expect(redirect.hrefs).toEqual([LOGIN_HREF]);
    expect(queryByTestId('spinner')).toBeNull();
    expect(queryByTestId('error-icon')).toBeNull();
  });
});

describe('Board Route Handoff event', () => {
  /** Fire the hand-off the way the real hook does: from inside its effect. */
  function handOff() {
    if (!handoff.current) throw new Error('the hook was never handed an onHandedOff callback');
    act(() => handoff.current?.());
  }

  // The success leg never arrives as a status: the hand-off effect navigates the
  // screen out of the tree in the same React batch, so a render carrying
  // `resolved` would be discarded with the fiber. It is reported imperatively
  // instead, and this is what proves the wiring survives.
  it('fires for a hand-off that the screen never renders a status for', () => {
    routeStatus.current = 'resolving';

    render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));
    expect(analytics.track).not.toHaveBeenCalled();

    handOff();

    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardRouteHandoff, {
      kind: 'climb',
      status: 'resolved',
      source: 'deep-link',
    });
  });

  it.each([
    ['auth-required', SLUG_CLIMB_TARGET, { kind: 'slug-climb', status: 'auth_required', source: 'deep-link' }],
    ['not-found', null, { kind: 'unparsed', status: 'not_found', source: 'deep-link' }],
  ] as const)('fires once for the %s terminal status', (status, target, expected) => {
    routeStatus.current = status;

    render(createElement(BoardRouteHandoff, { target }));

    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardRouteHandoff, expected);
  });

  it('tags an in-app open as its own source', () => {
    render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET, mode: 'in-app' }));
    handOff();

    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardRouteHandoff, {
      kind: 'climb',
      status: 'resolved',
      source: 'in-app',
    });
  });

  it('stays quiet while the route is still resolving', () => {
    routeStatus.current = 'resolving';

    render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));

    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('does not double-fire when the same status re-renders', () => {
    routeStatus.current = 'not-found';

    const { rerender } = render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));
    rerender(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));

    expect(analytics.track).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire when a hand-off is reported twice', () => {
    render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));
    handOff();
    handOff();

    expect(analytics.track).toHaveBeenCalledTimes(1);
  });

  // The web build reuses the mounted route component when a second link is
  // tapped, and two climbs on the same board settle to an identical `{ kind,
  // status, source }` — so deduplicating on the event props alone would silently
  // undercount every board-route open after the first.
  it('reports a second URL through the same mounted screen', () => {
    const { rerender } = render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));
    handOff();
    rerender(
      createElement(BoardRouteHandoff, {
        target: { ...CLIMB_TARGET, climbUuid: 'F9E8D7C6B5A4938271605F4E3D2C1B0A' } as BoardRouteTarget,
      }),
    );
    handOff();

    expect(analytics.track).toHaveBeenCalledTimes(2);
  });

  // A parsed URL that fails with no signal is the transient state the hook heals
  // on reconnect, not a dead link. Reporting it would inflate `not_found` with
  // every offline cold open that later succeeds — and count that open twice,
  // since the `resolved` follows under a different report key.
  it('holds the not-found back while the device is offline', () => {
    connectivity.isOnline = false;
    routeStatus.current = 'not-found';

    render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));

    expect(analytics.track).not.toHaveBeenCalled();
  });

  // Nothing about the network can turn an unparsed URL into a climb.
  it('reports an unparsed URL offline all the same', () => {
    connectivity.isOnline = false;
    routeStatus.current = 'not-found';

    render(createElement(BoardRouteHandoff, { target: null }));

    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardRouteHandoff, {
      kind: 'unparsed',
      status: 'not_found',
      source: 'deep-link',
    });
  });

  // The held-back not-found is not lost — a retry that fails with the network up
  // is the verdict this event is meant to carry.
  it('reports the not-found once the retry fails online', () => {
    connectivity.isOnline = false;
    routeStatus.current = 'not-found';

    const { rerender } = render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));
    expect(analytics.track).not.toHaveBeenCalled();

    connectivity.isOnline = true;
    routeStatus.current = 'resolving';
    rerender(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));
    routeStatus.current = 'not-found';
    rerender(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));

    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardRouteHandoff, {
      kind: 'climb',
      status: 'not_found',
      source: 'deep-link',
    });
  });
});

// The signed-out reader who gets the climb instead of the login wall. The
// hand-off telemetry is the same funnel — a status VALUE, not a new event — so
// `Climb Handoff Clicked` ÷ `Board Route Handoff` keeps counting the whole hop.
describe('BoardRouteHandoff anonymous climb', () => {
  it('draws the climb in place rather than redirecting', () => {
    routeStatus.current = 'anonymous-climb';

    const { queryByTestId } = render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));

    expect(queryByTestId('anonymous-climb-view')).not.toBeNull();
    expect(redirect.hrefs).toEqual([]);
    expect(anonymousView.props.at(-1)).toMatchObject({
      climb: ANONYMOUS_CLIMB,
      boardConfig: ANONYMOUS_BOARD_CONFIG,
    });
  });

  it('reports the arrival on the existing funnel as a status value', () => {
    routeStatus.current = 'anonymous-climb';

    render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));

    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardRouteHandoff, {
      kind: 'climb',
      status: 'anonymous',
      source: 'deep-link',
    });
  });

  // Only the slug branch resolves a board, and the flag lives on the board
  // record. Dropping it here is invisible in the view, whose own default is an
  // angle pill — so a gym wall bolted at one angle would still offer one.
  it('hands a fixed-angle board’s no-tilt setting to the view', () => {
    routeStatus.current = 'anonymous-climb';
    anonymousResult.isAngleAdjustable = false;

    render(createElement(BoardRouteHandoff, { target: SLUG_CLIMB_TARGET }));

    expect(anonymousView.props.at(-1)?.isAngleAdjustable).toBe(false);
  });

  it('keeps the pill for a board that tilts', () => {
    routeStatus.current = 'anonymous-climb';

    render(createElement(BoardRouteHandoff, { target: SLUG_CLIMB_TARGET }));

    expect(anonymousView.props.at(-1)?.isAngleAdjustable).toBe(true);
  });

  // `resolveStatus` refuses to say `anonymous-climb` before the climb lands, so
  // this state is unreachable today. It is pinned because the fall-through is
  // not benign: the redirector's only spinner used to be `resolving`, so a
  // loosened guard upstream would paint "Not found" + Back-to-home over a URL
  // that is one network round trip from rendering.
  it('waits on the spinner rather than a dead end when the climb has not landed', () => {
    routeStatus.current = 'anonymous-climb';
    anonymousResult.climbHasLanded = false;

    const { queryByTestId } = render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));

    expect(queryByTestId('spinner')).not.toBeNull();
    expect(queryByTestId('error-icon')).toBeNull();
    expect(queryByTestId('back-home')).toBeNull();
  });

  // The kill switch has to reach the decision, not just exist.
  it('passes the kill switch through to the gate', () => {
    anonymousClimbView.enabled = false;

    render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));

    expect(anonymousClimbView.seen.at(-1)).toBe(false);
  });
});
