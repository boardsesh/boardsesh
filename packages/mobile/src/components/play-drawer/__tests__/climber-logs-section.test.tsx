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

function renderSection(followState: 'none' | 'some' | 'unknown' = 'some') {
  const handlers = { onSeeAll: vi.fn(), onPressClimber: vi.fn(), onFindClimbers: vi.fn() };
  const view = render(
    createElement(ClimberLogsSection, {
      climbUuid: 'climb-1',
      boardName: 'kilter',
      angle: 40,
      climbGradeId: CLIMB_GRADE,
      followState,
      ...handlers,
    }),
  );
  return { ...view, ...handlers };
}

beforeEach(() => {
  rows.props = [];
  logsQuery.calls = [];
  logsQuery.state = IDLE;
  connectivity.snapshot = { effectiveOffline: false, reason: null };
});

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
});
