// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', { 'data-testid': 'icon' }) }));
vi.mock('../../Avatar', () => ({ Avatar: () => createElement('i', { 'data-testid': 'avatar' }) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'button',
      { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel, 'data-testid': 'pressable' },
      children,
    ),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGradeByDifficultyId: (difficultyId: number | null | undefined) =>
      difficultyId == null ? null : `grade:${difficultyId}`,
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#primary' }, systemColors: {} }),
}));

type RowProps = { group: { userId: string }; hideEarlier?: boolean; onPressClimber: (userId: string) => void };
const rows = vi.hoisted(() => ({ props: [] as RowProps[] }));
vi.mock('../ClimberLogRow', () => ({
  ClimberLogRow: (props: RowProps) => {
    rows.props.push(props);
    return createElement(
      'button',
      { type: 'button', 'data-testid': 'climber-row', onClick: () => props.onPressClimber(props.group.userId) },
      props.group.userId,
    );
  },
}));

type QueryState = {
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  isLoading: boolean;
  data: unknown;
  refetch: () => Promise<unknown>;
};
const logsQuery = vi.hoisted(() => ({
  state: null as unknown as QueryState,
  calls: [] as Array<{ boardName: string; climbUuid: string | null; enabled: boolean | undefined }>,
}));
vi.mock('../../../lib/graphql/hooks/use-following-climb-logs', () => ({
  useFollowingClimbLogs: (boardName: string, climbUuid: string | null, options?: { enabled?: boolean }) => {
    logsQuery.calls.push({ boardName, climbUuid, enabled: options?.enabled });
    return logsQuery.state;
  },
}));

// The card's fall-through: the newest logs from everyone else.
type PreviewState = { isLoading: boolean; data: unknown };
const previewQuery = vi.hoisted(() => ({
  state: { isLoading: false, data: undefined } as PreviewState,
  calls: [] as Array<{ boardName: string; climbUuid: string | null; enabled: boolean }>,
}));
vi.mock('../../../lib/graphql/hooks/use-climb-logs', () => ({
  useClimbLogsPreview: (args: { boardName: string; climbUuid: string | null; enabled: boolean }) => {
    previewQuery.calls.push(args);
    return previewQuery.state;
  },
}));
const viewer = vi.hoisted(() => ({
  state: { userId: 'viewer' as string | undefined, isLoading: false },
}));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => viewer.state,
}));

// The real reducer decides "blocked"; only the connectivity store is stood in.
const connectivity = vi.hoisted(() => ({
  snapshot: { effectiveOffline: false, reason: null as 'device_offline' | 'backend_unreachable' | null },
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivity: () => connectivity.snapshot }));

import { ClimberLogsSection } from '../ClimberLogsSection';
import type { ClimberLog } from '../climber-logs';

let nextId = 0;
function log(overrides: Partial<ClimberLog> = {}): ClimberLog {
  nextId += 1;
  return {
    uuid: `log-${nextId}`,
    userId: 'mika',
    userDisplayName: 'Mika',
    userAvatarUrl: null,
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: null,
    effectiveQuality: null,
    difficulty: null,
    comment: '',
    climbedAt: '2026-03-10T18:00:00',
    ...overrides,
  };
}

/** The climb is graded 16 at the board's angle, 40°. */
const CLIMB_GRADE = 16;

/** A climber with something to say, so they get a row. */
function noted(userId: string, overrides: Partial<ClimberLog> = {}): ClimberLog {
  return log({ userId, userDisplayName: userId, comment: `beta from ${userId}`, ...overrides });
}

/** A climber with nothing to add: a name in the footer, never a row. */
function bare(userId: string, overrides: Partial<ClimberLog> = {}): ClimberLog {
  return log({ userId, userDisplayName: userId, ...overrides });
}

function loaded(
  items: ClimberLog[],
  summary: { climberCount: number; senderCount: number },
  hasMore = false,
): QueryState {
  return {
    status: 'success',
    fetchStatus: 'idle',
    isLoading: false,
    data: { items, hasMore, summary: { ...summary, byAngle: [] } },
    refetch: vi.fn(),
  };
}

const IDLE: QueryState = {
  status: 'pending',
  fetchStatus: 'idle',
  isLoading: false,
  data: undefined,
  refetch: vi.fn(),
};

function renderSection(followState: 'none' | 'some' | 'unknown' = 'some', settled = true) {
  const handlers = { onSeeAll: vi.fn(), onPressClimber: vi.fn(), onFindClimbers: vi.fn() };
  const view = render(
    createElement(ClimberLogsSection, {
      climbUuid: 'climb-1',
      boardName: 'kilter',
      angle: 40,
      climbGradeId: CLIMB_GRADE,
      followState,
      settled,
      ...handlers,
    }),
  );
  return { ...view, ...handlers };
}

beforeEach(() => {
  rows.props = [];
  logsQuery.calls = [];
  logsQuery.state = IDLE;
  previewQuery.calls = [];
  previewQuery.state = { isLoading: false, data: undefined };
  viewer.state = { userId: 'viewer', isLoading: false };
  connectivity.snapshot = { effectiveOffline: false, reason: null };
});

const NOBODY_LOGGED = { climberCount: 0, senderCount: 0 };
const sixStrangers = () => ['s1', 's2', 's3', 's4', 's5', 's6'].map((userId) => noted(userId));

describe('ClimberLogsSection', () => {
  it('answers "follows nobody" from the phone, without asking the server', () => {
    const { container, getByText, onFindClimbers } = renderSection('none');

    expect(container.textContent).toContain('mobile.climberLogs.emptyFollowNobodyTitle');
    expect(container.textContent).toContain('mobile.climberLogs.emptyFollowNobodyBody');
    expect(logsQuery.calls.at(-1)).toEqual({ boardName: 'kilter', climbUuid: 'climb-1', enabled: false });

    fireEvent.click(getByText('mobile.climberLogs.findClimbers'));
    expect(onFindClimbers).toHaveBeenCalledTimes(1);
  });

  it('never claims the viewer follows nobody when the follow state is unknown', () => {
    logsQuery.state = loaded([], { climberCount: 0, senderCount: 0 });
    const { container } = renderSection('unknown');

    expect(logsQuery.calls.at(-1)?.enabled).toBe(true);
    expect(container.textContent).toContain('mobile.climberLogs.emptyNobodyLogged');
    expect(container.textContent).toContain('mobile.climberLogs.findClimbers');
    expect(container.textContent).not.toContain('mobile.climberLogs.emptyFollowNobodyTitle');
  });

  it('shows two fixed skeleton rows while the first request is in flight', () => {
    logsQuery.state = { ...IDLE, fetchStatus: 'fetching', isLoading: true };
    const { getAllByTestId, queryByTestId } = renderSection();

    expect(getAllByTestId('climber-logs-skeleton-row')).toHaveLength(2);
    expect(queryByTestId('climber-row')).toBeNull();
  });

  it('renders nothing, and no skeleton, for a query that is not asking', () => {
    // `status: 'pending'` with `fetchStatus: 'idle'` is a disabled query, not a loading one.
    logsQuery.state = IDLE;
    const { container } = renderSection();
    expect(container.childElementCount).toBe(0);
  });

  it('takes the header counts from the summary, never from the rows', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((userId) => noted(userId));
    logsQuery.state = loaded(items, { climberCount: 12, senderCount: 9 });
    const { container, getAllByTestId } = renderSection();

    expect(container.textContent).toContain('mobile.climberLogs.headline:{\\"count\\":12}');
    expect(container.textContent).toContain('mobile.climberLogs.sentCount:{\\"count\\":9}');
    // Six climbers came back; the drawer's plain ScrollView gets four of them.
    expect(getAllByTestId('climber-row')).toHaveLength(4);
  });

  it('gives a row only to climbers with a note or a grade that disagrees', () => {
    logsQuery.state = loaded(
      [bare('ana'), noted('tess'), bare('slab', { difficulty: 18 }), bare('agrees', { difficulty: CLIMB_GRADE })],
      { climberCount: 4, senderCount: 4 },
    );
    const { getAllByTestId } = renderSection();
    expect(getAllByTestId('climber-row').map((node) => node.textContent)).toEqual(['tess', 'slab']);
  });

  it('pools the bare climbers into the footer: three faces, two names and the rest as a number', () => {
    logsQuery.state = loaded(
      [
        noted('tess'),
        ...['ana', 'jo', 'kit', 'lena', 'ray', 'mj'].map((userId) => bare(userId)),
        bare('bea', { status: 'attempt' }),
      ],
      { climberCount: 8, senderCount: 7 },
    );
    const { getByTestId } = renderSection();

    const lines = getByTestId('climber-logs-bare');
    expect(lines.querySelectorAll('[data-testid="avatar"]')).toHaveLength(3);
    expect(lines.textContent).toContain('mobile.climberLogs.alsoSent');
    expect(lines.textContent).toContain('mobile.climberLogs.namesPlus:{"names":"ana, jo","count":4}');
    expect(lines.textContent).toContain('mobile.climberLogs.triedNoSend bea');
    expect(lines.textContent).not.toContain('mobile.climberLogs.sentIt');
  });

  it('says "and more" with no number when the server cut the logs at its cap', () => {
    logsQuery.state = loaded(
      ['ana', 'jo', 'kit'].map((userId) => bare(userId)),
      { climberCount: 40, senderCount: 30 },
      true,
    );
    const { getByTestId } = renderSection();
    const lines = getByTestId('climber-logs-bare');
    expect(lines.textContent).toContain('mobile.climberLogs.namesAndMore:{"names":"ana, jo"}');
    expect(lines.textContent).not.toContain('mobile.climberLogs.namesPlus');
  });

  it('says "Sent it" and shows no row when every log is bare', () => {
    logsQuery.state = loaded(
      ['ana', 'jo'].map((userId) => bare(userId)),
      { climberCount: 2, senderCount: 2 },
    );
    const { getByTestId, queryByTestId } = renderSection();
    expect(queryByTestId('climber-row')).toBeNull();
    expect(getByTestId('climber-logs-bare').textContent).toContain('mobile.climberLogs.sentIt ana, jo');
  });

  it('never drops a bare followed climber from the card to make room for rows', () => {
    logsQuery.state = loaded([bare('quiet-friend'), ...['a', 'b', 'c', 'd', 'e', 'f'].map((userId) => noted(userId))], {
      climberCount: 7,
      senderCount: 7,
    });
    const { getAllByTestId, getByTestId } = renderSection();
    expect(getAllByTestId('climber-row')).toHaveLength(4);
    expect(getByTestId('climber-logs-bare').textContent).toContain('quiet-friend');
  });

  it('makes the footer one button with one chevron: the bare names and "See all logs"', () => {
    logsQuery.state = loaded([noted('tess'), bare('ana')], { climberCount: 2, senderCount: 2 });
    const { getAllByTestId, getByTestId, onSeeAll } = renderSection();

    const footer = getAllByTestId('pressable').at(-1)!;
    expect(getAllByTestId('pressable')).toHaveLength(1);
    expect(footer.contains(getByTestId('climber-logs-bare'))).toBe(true);
    expect(footer.textContent).toContain('mobile.climberLogs.seeAll');
    expect(footer.querySelectorAll('[data-testid="icon"]')).toHaveLength(1);
    expect(footer.getAttribute('aria-label')).toContain('mobile.climberLogs.footerA11y');
    expect(footer.getAttribute('aria-label')).toContain('ana');

    fireEvent.click(getByTestId('climber-logs-bare'));
    expect(onSeeAll).toHaveBeenCalledTimes(1);
  });

  it('names a disagreeing grade in the summary line when the rows are complete', () => {
    logsQuery.state = loaded(
      [bare('a', { difficulty: 18 }), bare('b', { difficulty: 18 }), bare('c', { difficulty: CLIMB_GRADE })],
      { climberCount: 3, senderCount: 3 },
    );
    const { container } = renderSection();

    expect(container.textContent).toContain('mobile.climberLogs.gradedItCount:{"count":2,"grade":"grade:18"}');
    expect(container.textContent).not.toContain('grade:16');
    expect(rows.props.every((props) => props.hideEarlier === false)).toBe(true);
  });

  it('says nothing about grades when everybody agrees with the climb', () => {
    logsQuery.state = loaded([noted('a', { difficulty: CLIMB_GRADE })], { climberCount: 1, senderCount: 1 });
    expect(renderSection().container.textContent).not.toContain('mobile.climberLogs.gradedItCount');
  });

  it('hides the grades and the earlier-log words when the server cut the rows at its cap', () => {
    logsQuery.state = loaded(
      [noted('a', { difficulty: 18 }), log({ userId: 'a' })],
      { climberCount: 40, senderCount: 30 },
      true,
    );
    const { container } = renderSection();

    expect(container.textContent).not.toContain('mobile.climberLogs.gradedItCount');
    expect(rows.props.at(-1)?.hideEarlier).toBe(true);
  });

  it('opens the full list from "See all logs" and a profile from a row', () => {
    logsQuery.state = loaded([noted('mika')], { climberCount: 1, senderCount: 1 });
    const { getByText, getByTestId, onSeeAll, onPressClimber } = renderSection();

    fireEvent.click(getByText('mobile.climberLogs.seeAll'));
    expect(onSeeAll).toHaveBeenCalledTimes(1);

    fireEvent.click(getByTestId('climber-row'));
    expect(onPressClimber).toHaveBeenCalledWith('mika');
  });

  it('says the logs are not on the phone when the request is paused offline', () => {
    const refetch = vi.fn();
    connectivity.snapshot = { effectiveOffline: true, reason: 'device_offline' };
    logsQuery.state = { ...IDLE, fetchStatus: 'paused', refetch };
    const { container, getByText, queryByTestId } = renderSection();

    expect(container.textContent).toContain('mobile.offlineState.title');
    expect(container.textContent).toContain('mobile.climberLogs.offlineBody');
    expect(queryByTestId('climber-logs-skeleton')).toBeNull();

    fireEvent.click(getByText('mobile.offlineState.retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('blames the server, not the signal, when our backend is unreachable', () => {
    connectivity.snapshot = { effectiveOffline: true, reason: 'backend_unreachable' };
    logsQuery.state = { ...IDLE, fetchStatus: 'paused' };
    const { container } = renderSection();
    expect(container.textContent).toContain('mobile.offlineState.serverTitle');
  });

  it('fails closed on a server that rejects the document: an error placard and no rows', () => {
    // What an older backend answers: it has no `hasMore` or `summary` to select.
    const refetch = vi.fn();
    logsQuery.state = { status: 'error', fetchStatus: 'idle', isLoading: false, data: undefined, refetch };
    const { container, getByText, queryByTestId } = renderSection();

    expect(container.textContent).toContain('mobile.offlineState.errorTitle');
    expect(container.textContent).toContain('mobile.offlineState.errorBody');
    expect(container.textContent).not.toContain('mobile.climberLogs.offlineBody');
    expect(queryByTestId('climber-row')).toBeNull();

    fireEvent.click(getByText('mobile.offlineState.retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps rows it already has when a later refetch fails', () => {
    logsQuery.state = { ...loaded([noted('mika')], { climberCount: 1, senderCount: 1 }), status: 'error' };
    const { getAllByTestId, container } = renderSection();
    expect(getAllByTestId('climber-row')).toHaveLength(1);
    expect(container.textContent).not.toContain('mobile.offlineState.errorTitle');
  });

  describe('logs from everyone, when nobody followed has logged the climb', () => {
    it('adds them under the follow-nobody pitch, four at most, with a way to the full list', () => {
      previewQuery.state = { isLoading: false, data: sixStrangers() };
      const { container, getAllByTestId, getByText, onSeeAll, onPressClimber, onFindClimbers } = renderSection('none');

      // The pitch and its button stay exactly as they were.
      expect(container.textContent).toContain('mobile.climberLogs.emptyFollowNobodyTitle');
      expect(container.textContent).toContain('mobile.climberLogs.emptyFollowNobodyBody');
      fireEvent.click(getByText('mobile.climberLogs.findClimbers'));
      expect(onFindClimbers).toHaveBeenCalledTimes(1);

      expect(container.textContent).toContain('mobile.climberLogs.fallthrough.latestFromEveryone');
      // Six came back; the drawer's plain ScrollView gets four of them.
      expect(getAllByTestId('climber-row').map((node) => node.textContent)).toEqual(['s1', 's2', 's3', 's4']);
      expect(rows.props.every((props) => props.hideEarlier === true)).toBe(true);

      fireEvent.click(getByText('mobile.climberLogs.seeAll'));
      expect(onSeeAll).toHaveBeenCalledTimes(1);
      fireEvent.click(getAllByTestId('climber-row')[0]);
      expect(onPressClimber).toHaveBeenCalledWith('s1');
      // Still no request for followed climbers: there are none.
      expect(logsQuery.calls.at(-1)?.enabled).toBe(false);
    });

    it('adds them under the nobody-logged line, and drops "Find climbers" for the rows', () => {
      logsQuery.state = loaded([], NOBODY_LOGGED);
      previewQuery.state = { isLoading: false, data: sixStrangers() };
      const { container, getAllByTestId } = renderSection('some');

      expect(container.textContent).toContain('mobile.climberLogs.emptyNobodyLogged');
      expect(container.textContent).toContain('mobile.climberLogs.fallthrough.latestFromEveryone');
      expect(getAllByTestId('climber-row')).toHaveLength(4);
      expect(container.textContent).toContain('mobile.climberLogs.seeAll');
      expect(container.textContent).not.toContain('mobile.climberLogs.findClimbers');
    });

    it('gives strangers with nothing to add no row either: names in the footer, with no number', () => {
      logsQuery.state = loaded([], NOBODY_LOGGED);
      previewQuery.state = {
        isLoading: false,
        data: [noted('roofrat'), bare('dee'), bare('pilot'), bare('quin'), bare('tryer', { status: 'attempt' })],
      };
      const { getAllByTestId, getByTestId } = renderSection('some');

      expect(getAllByTestId('climber-row').map((node) => node.textContent)).toEqual(['roofrat']);
      const lines = getByTestId('climber-logs-bare');
      // The preview is the newest few logs, never all of them: "and more", not "+1".
      expect(lines.textContent).toContain('mobile.climberLogs.namesAndMore:{"names":"dee, pilot"}');
      expect(lines.textContent).toContain('mobile.climberLogs.triedNoSend tryer');
      expect(lines.textContent).not.toContain('mobile.climberLogs.namesPlus');
    });

    it('keeps everything about the people the viewer follows above the other climbers', () => {
      logsQuery.state = loaded([], NOBODY_LOGGED);
      previewQuery.state = { isLoading: false, data: sixStrangers() };
      const { container, getByTestId } = renderSection('some');

      const everyone = getByTestId('climber-logs-everyone');
      const message = container.textContent ?? '';
      expect(message.indexOf('mobile.climberLogs.emptyNobodyLogged')).toBeLessThan(
        message.indexOf('mobile.climberLogs.fallthrough.latestFromEveryone'),
      );
      // Every stranger's row, and the one footer button, sit inside that last block.
      expect(everyone.querySelectorAll('[data-testid="climber-row"]')).toHaveLength(4);
      expect(container.querySelectorAll('[data-testid="climber-row"]')).toHaveLength(4);
      expect(everyone.querySelectorAll('[data-testid="pressable"]')).toHaveLength(1);
      expect(container.lastElementChild?.contains(everyone)).toBe(true);
    });

    it('shows no other climbers once somebody the viewer follows has logged it', () => {
      logsQuery.state = loaded([bare('quiet-friend')], { climberCount: 1, senderCount: 1 });
      // A stale answer sits in the cache from before the friend logged it. A
      // disabled query still returns it; the card must not ask and must not show it.
      previewQuery.state = { isLoading: false, data: sixStrangers() };
      const { queryByTestId, getByTestId, container } = renderSection('some');

      expect(previewQuery.calls.at(-1)?.enabled).toBe(false);
      expect(queryByTestId('climber-logs-everyone')).toBeNull();
      expect(queryByTestId('climber-row')).toBeNull();
      expect(container.textContent).not.toContain('s1');
      expect(getByTestId('climber-logs-bare').textContent).toContain('quiet-friend');
    });

    it.each(['none', 'some'] as const)('shows no cached rows from an earlier visit with no signal (%s)', (state) => {
      connectivity.snapshot = { effectiveOffline: true, reason: 'device_offline' };
      logsQuery.state = loaded([], NOBODY_LOGGED);
      previewQuery.state = { isLoading: false, data: sixStrangers() };
      const { queryByTestId } = renderSection(state);

      expect(previewQuery.calls.at(-1)?.enabled).toBe(false);
      expect(queryByTestId('climber-logs-everyone')).toBeNull();
      expect(queryByTestId('climber-row')).toBeNull();
    });

    it("leaves out the viewer's own log even when the server sent it", () => {
      logsQuery.state = loaded([], NOBODY_LOGGED);
      previewQuery.state = { isLoading: false, data: [noted('viewer'), noted('s1')] };
      const { getAllByTestId } = renderSection('some');

      expect(getAllByTestId('climber-row').map((node) => node.textContent)).toEqual(['s1']);
    });

    it.each(['none', 'some'] as const)(
      'keeps the plain empty state when nobody else logged it either (%s)',
      (state) => {
        logsQuery.state = loaded([], NOBODY_LOGGED);
        previewQuery.state = { isLoading: false, data: [] };
        const { container, queryByTestId } = renderSection(state);

        expect(container.textContent).not.toContain('mobile.climberLogs.fallthrough.latestFromEveryone');
        expect(container.textContent).not.toContain('mobile.climberLogs.seeAll');
        expect(container.textContent).toContain('mobile.climberLogs.findClimbers');
        expect(queryByTestId('climber-row')).toBeNull();
      },
    );

    it('keeps the plain empty state when the request for them failed', () => {
      logsQuery.state = loaded([], NOBODY_LOGGED);
      previewQuery.state = { isLoading: false, data: undefined };
      const { container } = renderSection('some');

      expect(container.textContent).toContain('mobile.climberLogs.emptyNobodyLogged');
      expect(container.textContent).toContain('mobile.climberLogs.findClimbers');
    });

    it('holds the skeleton until they land, so the card resizes once', () => {
      logsQuery.state = loaded([], NOBODY_LOGGED);
      previewQuery.state = { isLoading: true, data: undefined };
      const { container, getByTestId } = renderSection('some');

      expect(getByTestId('climber-logs-skeleton')).toBeTruthy();
      expect(container.textContent).not.toContain('mobile.climberLogs.emptyNobodyLogged');
    });

    it('keeps the skeleton up from a cached "nobody logged" answer until the climb settles', () => {
      logsQuery.state = loaded([], NOBODY_LOGGED);
      const { container, getByTestId } = renderSection('some', false);

      expect(previewQuery.calls.at(-1)?.enabled).toBe(false);
      expect(getByTestId('climber-logs-skeleton')).toBeTruthy();
      expect(container.textContent).not.toContain('mobile.climberLogs.emptyNobodyLogged');
    });

    describe('for a viewer who follows nobody', () => {
      // The pitch never unmounts; only the slot under it waits.
      const expectPitchOverSkeleton = (view: ReturnType<typeof renderSection>) => {
        expect(view.container.textContent).toContain('mobile.climberLogs.emptyFollowNobodyTitle');
        expect(view.container.textContent).toContain('mobile.climberLogs.findClimbers');
        expect(view.getAllByTestId('climber-logs-skeleton-row')).toHaveLength(2);
      };

      it('keeps the pitch and its button mounted while the rows load', () => {
        previewQuery.state = { isLoading: true, data: undefined };
        expectPitchOverSkeleton(renderSection('none'));
      });

      it('shows the same card before the climb has settled, with no request out', () => {
        const view = renderSection('none', false);

        expect(previewQuery.calls.at(-1)?.enabled).toBe(false);
        expectPitchOverSkeleton(view);
      });

      it('shows the same card while the viewer id is still being read', () => {
        viewer.state = { userId: undefined, isLoading: true };
        expectPitchOverSkeleton(renderSection('none'));
      });

      it('holds no placeholder when there is no viewer id to ask with', () => {
        viewer.state = { userId: undefined, isLoading: false };
        const { container, queryByTestId } = renderSection('none', false);

        expect(container.textContent).toContain('mobile.climberLogs.emptyFollowNobodyTitle');
        expect(queryByTestId('climber-logs-skeleton')).toBeNull();
      });

      it('drops the placeholder when the request failed', () => {
        previewQuery.state = { isLoading: false, data: undefined };
        const { container, queryByTestId } = renderSection('none');

        expect(container.textContent).toContain('mobile.climberLogs.emptyFollowNobodyTitle');
        expect(queryByTestId('climber-logs-skeleton')).toBeNull();
      });

      it('shows rows it already has without waiting for the climb to settle', () => {
        previewQuery.state = { isLoading: false, data: sixStrangers() };
        const { getAllByTestId, queryByTestId } = renderSection('none', false);

        expect(getAllByTestId('climber-row')).toHaveLength(4);
        expect(queryByTestId('climber-logs-skeleton')).toBeNull();
      });
    });

    it.each(['none', 'some', 'unknown'] as const)(
      'asks for nothing on a climb the climber is only swiping past (%s)',
      (state) => {
        logsQuery.state = loaded([], NOBODY_LOGGED);
        renderSection(state, false);

        expect(logsQuery.calls.at(-1)?.enabled).toBe(false);
        expect(previewQuery.calls.at(-1)?.enabled).toBe(false);
      },
    );

    it('shows the skeleton, not an empty card, while a first visit waits to settle', () => {
      logsQuery.state = IDLE;
      const { getByTestId } = renderSection('some', false);
      expect(getByTestId('climber-logs-skeleton')).toBeTruthy();
    });

    it('asks once it is known nobody followed logged it', () => {
      renderSection('none');
      expect(previewQuery.calls.at(-1)).toEqual({ boardName: 'kilter', climbUuid: 'climb-1', enabled: true });

      logsQuery.state = loaded([], NOBODY_LOGGED);
      renderSection('unknown');
      expect(previewQuery.calls.at(-1)?.enabled).toBe(true);
    });

    it('does not ask while the followed-climbers request is still out', () => {
      logsQuery.state = { ...IDLE, fetchStatus: 'fetching', isLoading: true };
      renderSection('some');
      expect(previewQuery.calls.at(-1)?.enabled).toBe(false);
    });

    it('does not ask when somebody followed has logged the climb', () => {
      logsQuery.state = loaded([log()], { climberCount: 1, senderCount: 1 });
      const { container } = renderSection('some');

      expect(previewQuery.calls.at(-1)?.enabled).toBe(false);
      expect(container.textContent).not.toContain('mobile.climberLogs.fallthrough.latestFromEveryone');
    });

    it('does not ask when the followed-climbers request is blocked or failed', () => {
      logsQuery.state = { status: 'error', fetchStatus: 'idle', isLoading: false, data: undefined, refetch: vi.fn() };
      renderSection('some');
      expect(previewQuery.calls.at(-1)?.enabled).toBe(false);
    });

    it.each(['none', 'some'] as const)('does not ask with no signal (%s)', (state) => {
      connectivity.snapshot = { effectiveOffline: true, reason: 'device_offline' };
      // Rows from an earlier visit are still in the cache for `some`.
      logsQuery.state = loaded([], NOBODY_LOGGED);
      renderSection(state);
      expect(previewQuery.calls.at(-1)?.enabled).toBe(false);
    });
  });
});
