// @vitest-environment jsdom
//
// The report host's `onClosed` (#8151): the builder's near-miss fix waits on it
// before leaving the route, so it must fire exactly when the report is done
// with, and must always fire.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';

const state = vi.hoisted(() => ({ authenticated: true }));
const pushMock = vi.hoisted(() => vi.fn());
// The props each sheet was last drawn with, so a test can close it the way it
// would close itself.
const drawn = vi.hoisted(() => ({
  report: null as null | {
    onClose: () => void;
    onClaim: (gym: Gym) => void;
    closeAfterDismissed?: boolean;
    initialReason?: string | null;
    climbNowOffered?: boolean;
  },
  claim: null as null | { onClosed?: () => void },
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: state.authenticated }) }));
vi.mock('../../../providers/feature-flags-provider', () => ({ useDirectoryReportsEnabled: () => true }));
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => 'alex' }));
vi.mock('../ReportDirectorySheet', () => ({
  ReportDirectorySheet: (props: NonNullable<typeof drawn.report>) => {
    drawn.report = props;
    return createElement('div', { 'data-testid': 'report-sheet' });
  },
}));
vi.mock('../../gym-directory/ClaimGymSheet', () => ({
  ClaimGymSheet: (props: { onClosed?: () => void }) => {
    drawn.claim = props;
    return createElement('div', { 'data-testid': 'claim-sheet' });
  },
}));

const { useReportProblemHost } = await import('../use-report-problem');

const board = { uuid: 'board-1', name: 'Crux MoonBoard', ownerId: 'sam' } as UserBoard;
const gym = { uuid: 'gym-1', name: 'Crux' } as Gym;

type Host = ReturnType<typeof useReportProblemHost>;
function mountHost() {
  const host = { current: null as Host | null };
  function Harness(): ReactNode {
    host.current = useReportProblemHost();
    return host.current.sheet;
  }
  const rendered = render(createElement(Harness));
  return { ...rendered, host };
}

beforeEach(() => {
  state.authenticated = true;
  pushMock.mockClear();
  drawn.report = null;
  drawn.claim = null;
});

describe('useReportProblemHost onClosed', () => {
  it('asks the sheet to close only once it has slid away, and settles when it does', () => {
    const onClosed = vi.fn();
    const { host, queryByTestId } = mountHost();
    act(() =>
      host.current!.openReport(
        { kind: 'board', board },
        { initialReason: 'wrong_setup', climbNowOffered: false, onClosed },
      ),
    );
    expect(drawn.report).toMatchObject({
      closeAfterDismissed: true,
      initialReason: 'wrong_setup',
      climbNowOffered: false,
    });
    expect(onClosed).not.toHaveBeenCalled();

    act(() => drawn.report!.onClose());
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(queryByTestId('report-sheet')).toBeNull();
  });

  it('leaves an ordinary report closing straight away', () => {
    const { host } = mountHost();
    act(() => host.current!.openReport({ kind: 'board', board }));
    expect(drawn.report?.closeAfterDismissed).toBe(false);
  });

  it('settles after the claim sheet the report handed over to has closed, not before', () => {
    const onClosed = vi.fn();
    const { host, getByTestId } = mountHost();
    act(() => host.current!.openReport({ kind: 'board', board }, { onClosed }));
    act(() => drawn.report!.onClaim(gym));
    expect(getByTestId('claim-sheet')).toBeTruthy();
    expect(onClosed).not.toHaveBeenCalled();

    act(() => drawn.claim!.onClosed?.());
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('settles at once when signed out, since login opens instead of a sheet', () => {
    state.authenticated = false;
    const onClosed = vi.fn();
    const { host, queryByTestId } = mountHost();
    act(() => host.current!.openReport({ kind: 'board', board }, { onClosed }));
    expect(pushMock).toHaveBeenCalledWith('/auth/login');
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(queryByTestId('report-sheet')).toBeNull();
  });
});
