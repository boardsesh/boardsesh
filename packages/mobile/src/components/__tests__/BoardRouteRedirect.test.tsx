// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { BoardRouteTarget } from '../../lib/routing/board-route-target';
import type { BoardRouteStatus } from '../../lib/routing/use-board-route-target';

// What the gate hands back, as a sentinel. This suite asserts the component
// forwards that value VERBATIM; whether the value itself is right for a given
// location is `anonymous-auth-gate.web.test.ts`'s job.
const LOGIN_HREF = vi.hoisted(() => '/auth/login?next=%2Fb%2Fthe-gym%2F40%2Flist');

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const routeStatus = vi.hoisted(() => ({ current: 'resolving' as BoardRouteStatus }));
const redirect = vi.hoisted(() => ({ hrefs: [] as string[] }));
const router = vi.hoisted(() => ({ replace: vi.fn() }));

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
vi.mock('../../lib/routing/use-board-route-target', () => ({
  useBoardRouteTarget: () => routeStatus.current,
}));

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
});

describe('BoardRouteRedirect', () => {
  // A handed-off screen is navigating away. Flashing the not-found on its way
  // out would read as a broken link for a link that worked.
  it.each(['resolving', 'resolved'] as const)('draws the spinner at %s', (status) => {
    const { queryByTestId } = render(createElement(BoardRouteRedirect, { status }));

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
  it.each([
    ['resolved', CLIMB_TARGET, { kind: 'climb', status: 'resolved', source: 'deep-link' }],
    ['auth-required', SLUG_CLIMB_TARGET, { kind: 'slug-climb', status: 'auth_required', source: 'deep-link' }],
    ['not-found', null, { kind: 'unparsed', status: 'not_found', source: 'deep-link' }],
  ] as const)('fires once for the %s terminal status', (status, target, expected) => {
    routeStatus.current = status;

    render(createElement(BoardRouteHandoff, { target }));

    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardRouteHandoff, expected);
  });

  it('tags an in-app open as its own source', () => {
    routeStatus.current = 'resolved';

    render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET, mode: 'in-app' }));

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
    routeStatus.current = 'resolved';

    const { rerender } = render(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));
    rerender(createElement(BoardRouteHandoff, { target: CLIMB_TARGET }));

    expect(analytics.track).toHaveBeenCalledTimes(1);
  });
});
