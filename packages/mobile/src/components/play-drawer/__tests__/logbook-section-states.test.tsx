// @vitest-environment jsdom
// Which body the Logbook card shows, and how much of it. Two things here have
// bitten before and are pinned hard:
//
// 1. "No tries yet" on a climb the climber HAS logged. `useLogbook().isLoading`
//    is board-wide (false once any climb's ticks are cached) and goes false
//    while an offline fetch sits paused, so the card gates on this climb's
//    entry in `fetchedUuids` instead.
// 2. An uncapped `.map()` inside the play drawer's ScrollView
//    (docs/react-native-performance.md section 2).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';

// react-native isn't satisfiable under jsdom; stub the surface the card touches.
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  ActivityIndicator: () => createElement('i', { 'data-testid': 'spinner' }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, children),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // `key` alone, or `key(name=value,...)` so every interpolated segment,
    // including nested pre-translated ones, is assertable.
    t: (key: string, opts?: Record<string, unknown>) =>
      opts
        ? `${key}(${Object.entries(opts)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(',')})`
        : key,
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'light',
    brandColors: { primary: '#primary', primaryFill: '#primaryFill' },
    systemColors: {
      label: '#label',
      secondaryLabel: '#secondary',
      separator: '#separator',
      elevatedSurface: '#raised',
      fill: '#fill',
      accent: '#accent',
    },
  }),
}));
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#abcdef',
  DEFAULT_GRADE_COLOR: '#000000',
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGradeByDifficultyId: (id: number | null | undefined) => (id == null ? null : `V${id}`),
  }),
}));

// Capture stub: records each row's props so passthrough is assertable without
// rendering the real row.
const rows = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('../LogbookEntryRow', () => ({
  LogbookEntryRow: (props: Record<string, unknown>) => {
    rows.props.push(props);
    return createElement('div', { 'data-testid': 'entry-row' });
  },
}));

const logbookState = vi.hoisted(() => ({
  logbook: [] as unknown[],
  fetchedUuids: new Set<string>() as ReadonlySet<string>,
  error: null as Error | null,
  refetch: vi.fn(),
  // Deliberately misleading: the card must never read this board-wide flag.
  isLoading: false,
}));
vi.mock('@boardsesh/board-react', () => ({ useLogbook: () => logbookState }));

const pending = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../hooks/use-local-ticks', () => ({ useLocalPendingTicks: () => ({ data: pending.count }) }));

const connectivity = vi.hoisted(() => ({ effectiveOffline: false }));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivityField: (select: (snapshot: { effectiveOffline: boolean }) => unknown) => select(connectivity),
}));

// Noon UTC on 22 June 2026: "today" for every fixture below, in any timezone
// within twelve hours of UTC.
vi.mock('../../../lib/clock', () => ({ nowMs: () => Date.parse('2026-06-22T12:00:00Z') }));

vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));

import { LogbookSection } from '../LogbookSection';

function makeEntry(overrides: Partial<LogbookEntry>): LogbookEntry {
  return {
    uuid: 'tick-1',
    climb_uuid: 'climb-1',
    angle: 40,
    is_mirror: false,
    tries: 1,
    quality: null,
    difficulty: null,
    comment: '',
    climbed_at: '2026-06-01T12:00:00',
    is_ascent: true,
    status: 'send',
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    ...overrides,
  };
}

type RenderOptions = {
  angle?: number;
  userAscents?: number | null;
  userAttempts?: number | null;
  onOpenFullLogbook?: () => void;
};

function renderSection(options: RenderOptions = {}) {
  return render(
    createElement(LogbookSection, {
      climbUuid: 'climb-1',
      boardName: 'kilter',
      layoutId: 1,
      angle: options.angle ?? 40,
      userAscents: options.userAscents ?? 0,
      userAttempts: options.userAttempts ?? 0,
      onOpenFullLogbook: options.onOpenFullLogbook,
    }),
  );
}

/** One entry per day, counting back from 20 June. */
function sessionsAt(angle: number, count: number): LogbookEntry[] {
  return Array.from({ length: count }, (_, day) =>
    makeEntry({
      uuid: `${angle}-${day}`,
      angle,
      climbed_at: `2026-06-${String(20 - day).padStart(2, '0')}T12:00:00`,
    }),
  );
}

const STAT_TILE_KEYS = ['statTries', 'statSessions', 'statSends', 'statGrade'];

beforeEach(() => {
  rows.props = [];
  logbookState.logbook = [];
  logbookState.fetchedUuids = new Set(['climb-1']);
  logbookState.error = null;
  logbookState.refetch = vi.fn();
  logbookState.isLoading = false;
  pending.count = 0;
  connectivity.effectiveOffline = false;
});

describe('LogbookSection: before this climb’s logs have landed', () => {
  it('shows the spinner, not the untried state, when only ANOTHER climb is cached', () => {
    logbookState.logbook = [makeEntry({ uuid: 'other', climb_uuid: 'climb-2' })];
    logbookState.fetchedUuids = new Set(['climb-2']);
    const { container, queryByTestId } = renderSection();

    expect(queryByTestId('spinner')).not.toBeNull();
    expect(container.textContent).not.toContain('mobile.logbook.noEntries');
    expect(rows.props).toHaveLength(0);
  });

  it('holds the count fallback back until the fetch lands', () => {
    logbookState.fetchedUuids = new Set();
    const { container, queryByTestId } = renderSection({ userAscents: 2 });

    expect(queryByTestId('spinner')).not.toBeNull();
    expect(container.textContent).not.toContain('mobile.logbook.sendCount');
  });
});

describe('LogbookSection: no signal', () => {
  it.each([
    ['a paused fetch (offline, no error)', null],
    ['a fetch that failed while offline', new Error('Network request failed')],
  ])('says earlier logs need signal for %s, never "no tries yet"', (_label, error) => {
    logbookState.fetchedUuids = new Set();
    connectivity.effectiveOffline = true;
    logbookState.error = error;
    const { container, queryByTestId, queryByRole } = renderSection();

    expect(container.textContent).toContain('mobile.logbook.offlineEarlier');
    expect(container.textContent).not.toContain('mobile.logbook.loadFailedRetry');
    expect(container.textContent).not.toContain('mobile.logbook.noEntries');
    expect(queryByTestId('spinner')).toBeNull();
    // Nothing to tap: the paused fetch resumes by itself when signal returns.
    expect(queryByRole('button')).toBeNull();
  });

  it('adds the denormalised counts when the climb payload has them', () => {
    logbookState.fetchedUuids = new Set();
    connectivity.effectiveOffline = true;
    const { container } = renderSection({ userAscents: 2, userAttempts: 3 });

    expect(container.textContent).toContain('mobile.logbook.offlineEarlier');
    expect(container.textContent).toContain('mobile.logbook.sendCount(count=2)');
    expect(container.textContent).toContain('mobile.logbook.attemptCount(count=3)');
  });

  it('shows an optimistic tick as a ledger and still says the rest needs signal', () => {
    logbookState.fetchedUuids = new Set();
    connectivity.effectiveOffline = true;
    logbookState.logbook = [makeEntry({ uuid: 'temp-1', climbed_at: '2026-06-22T11:00:00' })];
    const { container } = renderSection();

    expect(container.textContent).toContain('mobile.logbook.verdictSend');
    expect(rows.props).toHaveLength(1);
    expect(container.textContent).toContain('mobile.logbook.offlineEarlier');
  });

  it('drops the line once this climb is fetched, even while offline', () => {
    connectivity.effectiveOffline = true;
    logbookState.logbook = [makeEntry({})];
    const { container } = renderSection();
    expect(container.textContent).not.toContain('mobile.logbook.offlineEarlier');
  });
});

describe('LogbookSection: the fetch failed with signal', () => {
  // A server error, a rate limit or an expired session. The climber is online,
  // so the card must not blame signal, and nothing retries unless they do.
  it('says the logs could not load and retries on tap, never "need signal" or "no tries yet"', () => {
    logbookState.fetchedUuids = new Set();
    logbookState.error = new Error('RATE_LIMITED');
    const { container, queryByTestId, getByRole } = renderSection();

    expect(container.textContent).toContain('mobile.logbook.loadFailedRetry');
    expect(container.textContent).not.toContain('mobile.logbook.offlineEarlier');
    expect(container.textContent).not.toContain('mobile.logbook.noEntries');
    expect(queryByTestId('spinner')).toBeNull();

    fireEvent.click(getByRole('button'));
    expect(logbookState.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the denormalised counts above the retry line', () => {
    logbookState.fetchedUuids = new Set();
    logbookState.error = new Error('Internal server error');
    const { container } = renderSection({ userAscents: 2 });

    expect(container.textContent).toContain('mobile.logbook.sendCount(count=2)');
    expect(container.textContent).toContain('mobile.logbook.loadFailedRetry');
  });

  it('offers the retry under an optimistic tick too', () => {
    logbookState.fetchedUuids = new Set();
    logbookState.error = new Error('Internal server error');
    logbookState.logbook = [makeEntry({ uuid: 'temp-1', climbed_at: '2026-06-22T11:00:00' })];
    const { container } = renderSection();

    expect(rows.props).toHaveLength(1);
    expect(container.textContent).toContain('mobile.logbook.loadFailedRetry');
  });
});

describe('LogbookSection: fetched with no logs', () => {
  it('shows the untried verdict alone, with no stat tiles', () => {
    const { container } = renderSection();
    const text = container.textContent ?? '';

    expect(text).toContain('mobile.logbook.noEntries');
    for (const key of STAT_TILE_KEYS) expect(text).not.toContain(`mobile.logbook.${key}`);
    expect(text).not.toContain('mobile.logbook.tilesAllAngles');
  });

  it('shows the count summary when the climb payload has counts', () => {
    const { container } = renderSection({ userAscents: 2 });
    const text = container.textContent ?? '';

    expect(text).toContain('mobile.logbook.sendCount(count=2)');
    expect(text).not.toContain('mobile.logbook.noEntries');
  });
});

describe('LogbookSection: the ledger body', () => {
  it('shows the verdict, the four tiles scoped to the board angle, and a dot per try', () => {
    logbookState.logbook = [
      makeEntry({ uuid: 'send', tries: 3, difficulty: 16, climbed_at: '2026-06-22T11:00:00' }),
      makeEntry({ uuid: 'burn', tries: 2, status: 'attempt', is_ascent: false, climbed_at: '2026-06-21T11:00:00' }),
    ];
    const { container, getAllByTestId } = renderSection();
    const text = container.textContent ?? '';

    expect(text).toContain('mobile.logbook.verdictSend(angle=40,when=mobile.logbook.whenToday)');
    expect(text).toContain('mobile.logbook.tilesAtAngle(angle=40)');
    for (const key of STAT_TILE_KEYS) expect(text).toContain(`mobile.logbook.${key}`);
    expect(text).toContain('V16');
    expect(text).toContain('mobile.logbook.dayToday');
    expect(text).toContain('mobile.logbook.dayYesterday');
    expect(text).toContain('mobile.logbook.sessionSent(tries=mobile.logbook.tries(count=3))');
    expect(getAllByTestId('try-dot-fall')).toHaveLength(4);
    expect(getAllByTestId('try-dot-send')).toHaveLength(1);
  });

  it('captions the tiles "all angles" when the board angle has no logs', () => {
    logbookState.logbook = [makeEntry({ angle: 45 })];
    const { container } = renderSection({ angle: 40 });
    expect(container.textContent).toContain('mobile.logbook.tilesAllAngles');
    expect(container.textContent).not.toContain('mobile.logbook.tilesAtAngle');
  });
});

describe('LogbookSection: pending row', () => {
  const branches: Array<[string, () => RenderOptions]> = [
    ['the ledger', () => ((logbookState.logbook = [makeEntry({})]), {})],
    ['the spinner', () => ((logbookState.fetchedUuids = new Set()), {})],
    ['the offline line', () => ((logbookState.fetchedUuids = new Set()), (connectivity.effectiveOffline = true), {})],
    ['the count summary', () => ({ userAscents: 2 })],
    ['the untried verdict', () => ({})],
  ];

  it.each(branches)('leads %s and carries only the pending-sync line', (_label, arrange) => {
    pending.count = 1;
    const { container } = renderSection(arrange());
    const card = container.firstElementChild;

    expect(card?.firstElementChild?.textContent).toBe('mobile.logbook.pendingSync(count=1)');
    expect((container.textContent ?? '').match(/pendingSync/g)).toHaveLength(1);
  });

  it('is absent when nothing is queued', () => {
    logbookState.logbook = [makeEntry({})];
    const { container } = renderSection();
    expect(container.textContent).not.toContain('mobile.logbook.pendingSync');
  });
});

describe('LogbookSection: inline caps', () => {
  it('renders 6 of 9 sessions and one row to the full logbook; nothing expands inline', () => {
    logbookState.logbook = sessionsAt(40, 9);
    const onOpenFullLogbook = vi.fn();
    const { container, getAllByTestId, getByRole } = renderSection({ onOpenFullLogbook });

    expect(getAllByTestId('logbook-session-tile')).toHaveLength(6);
    expect(container.textContent).toContain('mobile.logbook.seeFullLogbook(count=3)');

    fireEvent.click(getByRole('button'));
    expect(onOpenFullLogbook).toHaveBeenCalledTimes(1);
    expect(getAllByTestId('logbook-session-tile')).toHaveLength(6);
  });

  it('renders 4 rows of a 30-log day and counts the other 26', () => {
    logbookState.logbook = Array.from({ length: 30 }, (_, index) =>
      makeEntry({
        uuid: `log-${index}`,
        status: 'attempt',
        is_ascent: false,
        climbed_at: `2026-06-20T12:${String(index).padStart(2, '0')}:00`,
      }),
    );
    const { container, getAllByTestId } = renderSection({ onOpenFullLogbook: vi.fn() });

    expect(getAllByTestId('logbook-session-tile')).toHaveLength(1);
    expect(rows.props).toHaveLength(4);
    // Newest four of the day.
    expect(rows.props.map((rowProps) => (rowProps.entry as LogbookEntry).uuid)).toEqual([
      'log-29',
      'log-28',
      'log-27',
      'log-26',
    ]);
    expect(container.textContent).toContain('mobile.logbook.moreLogsThatDay(count=26)');
    // No session is hidden, only rows inside one: the row drops its count.
    expect(container.textContent).toContain('mobile.logbook.seeFullLogbookPlain');
  });

  it('spends the budget on the board angle first', () => {
    logbookState.logbook = [...sessionsAt(45, 6), ...sessionsAt(40, 2)];
    const { container, getAllByTestId } = renderSection({ angle: 40, onOpenFullLogbook: vi.fn() });

    expect(getAllByTestId('logbook-session-tile')).toHaveLength(6);
    const rowAngles = rows.props.map((rowProps) => (rowProps.entry as LogbookEntry).angle);
    expect(rowAngles).toEqual([40, 40, 45, 45, 45, 45]);
    expect(container.textContent).toContain('mobile.logbook.seeFullLogbook(count=2)');
  });

  it('keeps an angle’s header when the budget ran out before its tiles', () => {
    logbookState.logbook = [...sessionsAt(40, 6), ...sessionsAt(45, 1)];
    const { container } = renderSection({ angle: 40, onOpenFullLogbook: vi.fn() });
    expect(container.textContent).toContain('45°');
    expect(rows.props.every((rowProps) => (rowProps.entry as LogbookEntry).angle === 40)).toBe(true);
  });

  it('offers no row when everything fits', () => {
    logbookState.logbook = sessionsAt(40, 6);
    const { container, queryByRole } = renderSection({ onOpenFullLogbook: vi.fn() });
    expect(queryByRole('button')).toBeNull();
    expect(container.textContent).not.toContain('seeFullLogbook');
  });
});
