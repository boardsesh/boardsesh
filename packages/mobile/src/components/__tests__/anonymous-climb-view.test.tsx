// @vitest-environment jsdom
// The read-only climb surface a signed-out visitor gets on app.boardsesh.com.
//
// Three claims are load-bearing enough to pin here, because each has a failure
// mode that looks fine in a screenshot:
//
// 1. The sign-in control uses the GATE's href, not a hand-rolled `/auth/login`.
//    A bare login route drops the `?next=`, so the visitor signs in and lands on
//    Home having lost the climb they followed a search result to reach — the
//    exact regression the round trip was built to prevent.
// 2. The drawer opens with a `previewQueueItem`, which is what leaves the queue
//    untouched.
// 3. An angle change bumps the open target's nonce. PlayDrawer clears its
//    preview on every angle change and re-reads `openTarget` afterwards; without
//    a fresh nonce the anonymous drawer falls back to a queue that is empty here
//    and blanks itself.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { act, createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

// The gate's return, as a sentinel: this suite asserts the view forwards that
// value verbatim. Whether the value is right for a given location is
// `anonymous-auth-gate.web.test.ts`'s job.
const LOGIN_HREF = vi.hoisted(() => '/auth/login?next=%2Fkilter%2F1%2F10%2F1%2C20%2F40%2Fview%2Fcrimpy-thing-0A1B');
const buildLoginHrefWithReturn = vi.hoisted(() => vi.fn(() => LOGIN_HREF));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const drawerProps = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode } & Record<string, unknown>) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'web' },
  PlatformColor: (name: string) => name,
}));
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#111', secondaryLabel: '#888', separator: '#333' } }),
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { 'data-testid': 'sign-in', onClick: onPress }, title),
}));
vi.mock('../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: Climb) => ({ uuid: 'queue-item-uuid', climb }),
}));
vi.mock('../../lib/routing/anonymous-auth-gate', () => ({ buildLoginHrefWithReturn }));
vi.mock('../play-drawer/PlayDrawer', () => ({
  PlayDrawer: (props: Record<string, unknown>) => {
    drawerProps.calls.push(props);
    return createElement('div', { 'data-testid': 'play-drawer' });
  },
}));

const { AnonymousClimbView } = await import('../AnonymousClimbView');

const BOARD_CONFIG = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const CLIMB = { uuid: '0A1B2C3D4E5F60718293A4B5C6D7E8F9', name: 'Crimpy Thing' } as unknown as Climb;

function lastDrawerProps(): Record<string, unknown> {
  const props = drawerProps.calls.at(-1);
  if (!props) throw new Error('PlayDrawer never rendered');
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  drawerProps.calls = [];
  buildLoginHrefWithReturn.mockReturnValue(LOGIN_HREF);
});

describe('AnonymousClimbView', () => {
  it('renders the drawer in place as an anonymous pane — never as the /play route', () => {
    render(createElement(AnonymousClimbView, { climb: CLIMB, boardConfig: BOARD_CONFIG }));
    const props = lastDrawerProps();

    expect(props.presentation).toBe('pane');
    expect(props.viewer).toBe('anonymous');
    // `/boards` is outside the read-only allow-set, so a switch-board scrim
    // would bounce the visitor to login the moment they tapped it.
    expect(props.boardMismatch).toBeUndefined();
    expect(props.onSwitchBoard).toBeUndefined();
  });

  it('opens the climb as a preview so the queue is never written', () => {
    render(createElement(AnonymousClimbView, { climb: CLIMB, boardConfig: BOARD_CONFIG }));
    const openTarget = lastDrawerProps().openTarget as { climb: Climb; options: { previewQueueItem: unknown } };

    expect(openTarget.climb).toBe(CLIMB);
    expect(openTarget.options.previewQueueItem).toEqual({ uuid: 'queue-item-uuid', climb: CLIMB });
  });

  it('sends the sign-in bar to the href the gate builds, not a bare login route', () => {
    const { getByTestId } = render(createElement(AnonymousClimbView, { climb: CLIMB, boardConfig: BOARD_CONFIG }));

    act(() => getByTestId('sign-in').click());

    expect(router.push).toHaveBeenCalledWith(LOGIN_HREF);
    expect(router.push).not.toHaveBeenCalledWith('/auth/login');
  });

  it('sends the drawer’s own sign-in prompt to the same gate href', () => {
    render(createElement(AnonymousClimbView, { climb: CLIMB, boardConfig: BOARD_CONFIG }));
    const onSignIn = lastDrawerProps().onSignIn as () => void;

    act(() => onSignIn());

    expect(router.push).toHaveBeenCalledWith(LOGIN_HREF);
  });

  // The angle selector can hand back the angle already showing. Re-opening for
  // it would rebuild the preview item for nothing.
  it('leaves the open target alone when the angle has not actually moved', () => {
    render(createElement(AnonymousClimbView, { climb: CLIMB, boardConfig: BOARD_CONFIG }));
    const beforeTarget = lastDrawerProps().openTarget as { nonce: number };
    const onAngleChange = lastDrawerProps().onAngleChange as (angle: number) => void;

    act(() => onAngleChange(BOARD_CONFIG.angle));

    expect((lastDrawerProps().openTarget as { nonce: number }).nonce).toBe(beforeTarget.nonce);
  });

  it('re-applies the open target when the angle moves so the drawer cannot blank', () => {
    render(createElement(AnonymousClimbView, { climb: CLIMB, boardConfig: BOARD_CONFIG }));
    const beforeTarget = lastDrawerProps().openTarget as { nonce: number };
    const onAngleChange = lastDrawerProps().onAngleChange as (angle: number) => void;

    act(() => onAngleChange(25));

    const afterProps = lastDrawerProps();
    expect((afterProps.boardConfig as { angle: number }).angle).toBe(25);
    expect((afterProps.openTarget as { nonce: number }).nonce).toBeGreaterThan(beforeTarget.nonce);
  });
});
