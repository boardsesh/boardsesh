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
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../Avatar', () => ({ Avatar: () => createElement('i', { 'data-testid': 'avatar' }) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, children),
}));
vi.mock('../../ascent-marks', () => ({
  GradePill: ({ difficultyId }: { difficultyId: number }) => createElement('span', null, `grade:${difficultyId}`),
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

  it('shows four fixed skeleton rows while the first request is in flight', () => {
    logsQuery.state = { ...IDLE, fetchStatus: 'fetching', isLoading: true };
    const { getAllByTestId, queryByTestId } = renderSection();

    expect(getAllByTestId('climber-logs-skeleton-row')).toHaveLength(4);
    expect(queryByTestId('climber-row')).toBeNull();
  });

  it('renders nothing, and no skeleton, for a query that is not asking', () => {
    // `status: 'pending'` with `fetchStatus: 'idle'` is a disabled query, not a loading one.
    logsQuery.state = IDLE;
    const { container } = renderSection();
    expect(container.childElementCount).toBe(0);
  });

  it('takes the header counts from the summary, never from the rows', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((userId) => log({ userId }));
    logsQuery.state = loaded(items, { climberCount: 12, senderCount: 9 });
    const { container, getAllByTestId } = renderSection();

    expect(container.textContent).toContain('mobile.climberLogs.headline:{\\"count\\":12}');
    expect(container.textContent).toContain('mobile.climberLogs.sentCount:{\\"count\\":9}');
    // Six climbers came back; the drawer's plain ScrollView gets four of them.
    expect(getAllByTestId('climber-row')).toHaveLength(4);
  });

  it('shows the grades they gave when the rows are complete', () => {
    logsQuery.state = loaded(
      [
        log({ userId: 'a', difficulty: 16 }),
        log({ userId: 'b', difficulty: 16 }),
        log({ userId: 'c', difficulty: 18 }),
      ],
      { climberCount: 3, senderCount: 3 },
    );
    const { container, getAllByTestId } = renderSection();

    expect(container.textContent).toContain('mobile.climberLogs.gradeTally');
    expect(getAllByTestId('climber-logs-tally-grade').map((node) => node.textContent)).toEqual([
      'grade:16mobile.climberLogs.gradeTallyItem:{"count":2}',
      'grade:18mobile.climberLogs.gradeTallyItem:{"count":1}',
    ]);
    expect(rows.props.every((props) => props.hideEarlier === false)).toBe(true);
  });

  it('hides the tally and the earlier-log lines when the server cut the rows at its cap', () => {
    logsQuery.state = loaded(
      [log({ userId: 'a', difficulty: 16 }), log({ userId: 'a' })],
      { climberCount: 40, senderCount: 30 },
      true,
    );
    const { container, queryByTestId } = renderSection();

    expect(container.textContent).not.toContain('mobile.climberLogs.gradeTally');
    expect(queryByTestId('climber-logs-tally-grade')).toBeNull();
    expect(rows.props.at(-1)?.hideEarlier).toBe(true);
  });

  it('opens the full list from "See all logs" and a profile from a row', () => {
    logsQuery.state = loaded([log({ userId: 'mika' })], { climberCount: 1, senderCount: 1 });
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
    logsQuery.state = { ...loaded([log()], { climberCount: 1, senderCount: 1 }), status: 'error' };
    const { getAllByTestId, container } = renderSection();
    expect(getAllByTestId('climber-row')).toHaveLength(1);
    expect(container.textContent).not.toContain('mobile.offlineState.errorTitle');
  });
});
