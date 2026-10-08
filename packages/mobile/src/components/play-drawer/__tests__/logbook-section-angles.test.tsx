// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import type { LogbookEntry } from '@boardsesh/board-react';

// react-native isn't satisfiable under jsdom; stub the surface the card touches.
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  ActivityIndicator: () => createElement('i', { 'data-testid': 'spinner' }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
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
  // Deliberately misleading: the card must never read this board-wide flag.
  isLoading: false,
}));
vi.mock('@boardsesh/board-react', () => ({ useLogbook: () => logbookState }));
vi.mock('../../../hooks/use-local-climb-ticks', () => ({ useLocalClimbTicks: () => undefined }));

const pending = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../hooks/use-local-ticks', () => ({ useLocalPendingTicks: () => ({ data: pending.count }) }));

const connectivity = vi.hoisted(() => ({ effectiveOffline: false }));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivityField: (select: (snapshot: { effectiveOffline: boolean }) => unknown) => select(connectivity),
}));

// Noon UTC on 22 June 2026: "today" for every fixture below, in any timezone
// within twelve hours of UTC.
vi.mock('../../../lib/clock', () => ({ nowMs: () => Date.parse('2026-06-22T12:00:00Z') }));

// Every case here is about a member's own entries, so the session is signed in.
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

const attempt = (overrides: Partial<LogbookEntry>) => makeEntry({ status: 'attempt', is_ascent: false, ...overrides });

function renderSection(options: { boardName?: BoardName; layoutId?: number; angle?: number } = {}) {
  return render(
    createElement(LogbookSection, {
      climbUuid: 'climb-1',
      boardName: options.boardName ?? 'kilter',
      layoutId: options.layoutId ?? 1,
      angle: options.angle ?? 40,
      userAscents: null,
      userAttempts: null,
    }),
  );
}

const recap = (tries: number, sessions: number) =>
  `mobile.logbook.lifetimeRecap(tries=mobile.logbook.lifetimeTries(count=${tries}),sessions=mobile.logbook.lifetimeSessions(count=${sessions}))`;
const angleLine = (result: string, tries: number, sessions: number) =>
  `mobile.logbook.angleLine(result=${result},recap=${recap(tries, sessions)})`;
const statRecap = (tries: number, sends: number, sessions: number) =>
  `mobile.logbook.statRecap(tries=mobile.logbook.lifetimeTries(count=${tries}),sends=mobile.logbook.sendCount(count=${sends}),sessions=mobile.logbook.lifetimeSessions(count=${sessions}))`;

beforeEach(() => {
  rows.props = [];
  logbookState.logbook = [];
  logbookState.fetchedUuids = new Set(['climb-1']);
  logbookState.error = null;
  pending.count = 0;
  connectivity.effectiveOffline = false;
});

describe('LogbookSection: per-angle sections', () => {
  const threeAngles = [
    attempt({ uuid: 'a', angle: 40, tries: 4, climbed_at: '2026-06-01T10:00:00' }),
    makeEntry({ uuid: 'b', angle: 40, tries: 3, climbed_at: '2026-06-20T10:00:00' }),
    attempt({ uuid: 'c', angle: 45, tries: 2, climbed_at: '2026-06-21T10:00:00' }),
    makeEntry({ uuid: 'd', angle: 30, tries: 1, status: 'flash', climbed_at: '2026-06-10T10:00:00' }),
  ];

  it('leads with the board angle, then the rest steepest first', () => {
    logbookState.logbook = threeAngles;
    renderSection({ angle: 40 });
    const rowAngles = rows.props.map((rowProps) => (rowProps.entry as LogbookEntry).angle);
    expect(rowAngles).toEqual([40, 40, 45, 30]);
  });

  it('is plain steepest first when the board angle has no logs', () => {
    logbookState.logbook = threeAngles;
    renderSection({ angle: 55 });
    const rowAngles = rows.props.map((rowProps) => (rowProps.entry as LogbookEntry).angle);
    expect(rowAngles).toEqual([45, 40, 40, 30]);
  });

  it('marks only the board angle as where the board is', () => {
    logbookState.logbook = threeAngles;
    const { container } = renderSection({ angle: 40 });
    const text = container.textContent ?? '';
    expect(text.match(/mobile\.logbook\.angleBoardIsHere/g)).toHaveLength(1);
    // Plain words in the 40° heading, ahead of the 45° one.
    expect(text).toContain('40° · mobile.logbook.angleBoardIsHere');
    expect(text.indexOf('mobile.logbook.angleBoardIsHere')).toBeLessThan(text.indexOf('45°'));

    rows.props = [];
    const elsewhere = renderSection({ angle: 55 });
    expect(elsewhere.container.textContent).not.toContain('mobile.logbook.angleBoardIsHere');
  });

  it('tells each angle’s story: which session the send came in, a flash, or no send', () => {
    logbookState.logbook = threeAngles;
    const { container } = renderSection({ angle: 40 });
    const text = container.textContent ?? '';
    // 40°: 4 falls then a send of 3 on a second day. The board's angle tells
    // its story once, in the line under the verdict, not again in its heading.
    expect(text).toContain(
      `mobile.logbook.angleLine(result=mobile.logbook.angleSentInSession(session=2),recap=${statRecap(7, 1, 2)})`,
    );
    expect(text).not.toContain(angleLine('mobile.logbook.angleSentInSession(session=2)', 7, 2));
    expect(text).toContain(`45° · ${angleLine('mobile.logbook.angleNoSend', 2, 1)}`);
    expect(text).toContain(`30° · ${angleLine('mobile.logbook.angleFlashed', 1, 1)}`);
  });

  it('gives every angle its story when the board angle has no logs', () => {
    logbookState.logbook = threeAngles;
    const { container } = renderSection({ angle: 55 });
    const text = container.textContent ?? '';
    expect(text).toContain(`mobile.logbook.statLineAllAngles(recap=${statRecap(10, 2, 4)})`);
    expect(text).toContain(`40° · ${angleLine('mobile.logbook.angleSentInSession(session=2)', 7, 2)}`);
  });

  it('prints a day’s try count only under an angle with more than one day', () => {
    logbookState.logbook = threeAngles;
    const { container } = renderSection({ angle: 40 });
    const text = container.textContent ?? '';
    // 40° has two days; 45° and 30° have one each.
    expect(text).toContain('mobile.logbook.tries(count=3)');
    expect(text).toContain('mobile.logbook.tries(count=4)');
    expect(text).not.toContain('mobile.logbook.tries(count=2)');
    expect(text).not.toContain('mobile.logbook.tries(count=1)');
  });

  it('hands rows no angle chip prop', () => {
    logbookState.logbook = threeAngles;
    renderSection();
    expect(rows.props).toHaveLength(4);
    expect(rows.props.every((rowProps) => !('showAngleChip' in rowProps))).toBe(true);
  });
});

describe('LogbookSection: one angle', () => {
  it('prints no angle heading and no "board is here" at the board angle', () => {
    logbookState.logbook = [
      makeEntry({ uuid: 'flash', status: 'flash', climbed_at: '2026-06-21T10:00:00' }),
      makeEntry({ uuid: 'repeat', tries: 3, climbed_at: '2026-06-21T10:02:00' }),
    ];
    const { container } = renderSection({ angle: 40 });
    const text = container.textContent ?? '';
    expect(text).toContain(`mobile.logbook.angleLine(result=mobile.logbook.angleFlashed,recap=${statRecap(4, 2, 1)})`);
    expect(text).not.toContain('40°');
    expect(text).not.toContain('mobile.logbook.angleBoardIsHere');
    // One day at the angle: the line above already has the count.
    expect(text).not.toContain('mobile.logbook.tries(');
  });

  it('tells the one angle’s story under the verdict when the board is set elsewhere', () => {
    logbookState.logbook = [makeEntry({ uuid: 'only', angle: 35, tries: 2 })];
    const { container } = renderSection({ angle: 40 });
    const text = container.textContent ?? '';
    expect(text).toContain(
      `mobile.logbook.angleLine(result=mobile.logbook.angleSentInSession(session=1),recap=${statRecap(2, 1, 1)})`,
    );
    expect(text).not.toContain('mobile.logbook.statLineAllAngles');
    expect(text).not.toContain('35°');
  });

  it('leaves the sends out of the line when there are none', () => {
    logbookState.logbook = [attempt({ uuid: 'burn', tries: 5 })];
    const { container } = renderSection({ angle: 40 });
    const text = container.textContent ?? '';
    expect(text).toContain(angleLine('mobile.logbook.angleNoSend', 5, 1));
    expect(text).not.toContain('mobile.logbook.statRecap');
  });

  it('adds the climber’s own grade only when they gave one', () => {
    logbookState.logbook = [makeEntry({ uuid: 'graded', difficulty: 16 })];
    const graded = renderSection({ angle: 40 });
    expect(graded.container.textContent).toMatch(/mobile\.logbook\.statLineWithGrade\(line=.*,grade=V16\)/);

    logbookState.logbook = [makeEntry({ uuid: 'ungraded' })];
    const ungraded = renderSection({ angle: 40 });
    expect(ungraded.container.textContent).not.toContain('mobile.logbook.statLineWithGrade');
  });
});

describe('LogbookSection: chronological sort (#3569)', () => {
  it('orders sessions newest-first by true UTC instant, not raw string/local-Date order', () => {
    // `climbed_at` is a naive-but-UTC string with no `Z` suffix. The ledger
    // sorts through `tickTimeMs`, which parses it explicitly as UTC; a bare
    // `new Date(x)` would parse it as device-local, and how an ambiguous or
    // skipped local hour resolves is implementation-defined per ECMA-262, so
    // Hermes (on-device) isn't guaranteed to agree with V8 (this runner).
    logbookState.logbook = [
      makeEntry({ uuid: 'oldest', climbed_at: '2026-06-01T09:00:00' }),
      makeEntry({ uuid: 'newest', climbed_at: '2026-06-20T12:00:00' }),
      makeEntry({ uuid: 'middle', climbed_at: '2026-06-10T12:00:00' }),
    ];
    renderSection();
    const rowUuids = rows.props.map((rowProps) => (rowProps.entry as LogbookEntry).uuid);
    expect(rowUuids).toEqual(['newest', 'middle', 'oldest']);
  });
});

describe('LogbookSection direction capability', () => {
  it.each([
    ['woods', 1, true],
    ['decoy', 1, true],
    ['tension', 10, true],
    ['tension', 11, false],
    ['kilter', 1, false],
  ])('gates direction tags for %s layout %s', (boardName, layoutId, expected) => {
    logbookState.logbook = [makeEntry({}), makeEntry({ uuid: 'mirror', is_mirror: true })];
    renderSection({ boardName: boardName as BoardName, layoutId: layoutId as number });
    expect(rows.props).toHaveLength(2);
    expect(rows.props.every((props) => props.showMirrorTag === expected)).toBe(true);
  });
});
