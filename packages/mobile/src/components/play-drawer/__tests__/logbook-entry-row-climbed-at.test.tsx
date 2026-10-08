// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';

// Pinned so these assertions don't depend on the host/CI machine's default TZ
// (which could be UTC, silently masking the very bug this suite guards
// against — see #3569). America/Phoenix keeps a fixed UTC-7 offset
// year-round (no DST), so there's no ambiguity around the fixture dates
// crossing a DST boundary. Stubbed via `vi.stubEnv` + `vi.unstubAllEnvs` so
// it can't leak into other test files sharing this worker.
beforeAll(() => {
  vi.stubEnv('TZ', 'America/Phoenix');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

// react-native isn't satisfiable under jsdom; stub the surface the row touches.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ colorScheme: 'light', brandColors: {}, systemColors: {} }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGradeByDifficultyId: (id: number | null | undefined) => (id == null ? null : `V${id}`),
  }),
}));
// The row prints the time of day only (the day line above it names the
// day), so hour and minute are the whole assertion.
// Stand-in for the real Intl formatter that reads the Date's LOCAL getters
// directly. This keeps the assertion decoupled from host ICU locale/format
// quirks (see the "never pass locale: undefined" convention documented in
// intl-formatter-cache.test.ts — a convention the production call site can't
// itself follow, since it formats in whatever locale the device is set to)
// while still exercising exactly what this suite cares about: does the row
// build a `Date` whose LOCAL wall-clock matches the tick's true local time,
// rather than the raw stored UTC digits.
const formatter = vi.hoisted(() => ({ options: [] as Intl.DateTimeFormatOptions[] }));
vi.mock('../../../lib/intl-formatter-cache', () => ({
  getCachedDateTimeFormat: (_locale: unknown, options: Intl.DateTimeFormatOptions) => {
    formatter.options.push(options);
    return {
      format: (date: Date) => `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`,
    };
  },
}));

import { LogbookEntryRow } from '../LogbookEntryRow';

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
    climbed_at: '2026-07-24T15:14:00',
    is_ascent: true,
    status: 'send',
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    ...overrides,
  };
}

describe('LogbookEntryRow climbed-at display (#3569)', () => {
  it('renders the tick in local wall-clock time, not the raw stored UTC digits', () => {
    // `boardsesh_ticks.climbed_at` is a naive-but-UTC string with no `Z`
    // suffix (see @boardsesh/profile-stats/format-tick-time). A tick logged
    // at 8:14 AM in America/Phoenix (UTC-7, no DST) is stored as
    // "...T15:14:00". Pre-fix, `formatClimbedAt` parsed that string with a
    // bare `new Date(iso)`, which V8/Hermes treat as already-local — so the
    // row displayed the raw "15:14" digits unchanged instead of "8:14".
    const { getByText } = render(
      createElement(LogbookEntryRow, {
        entry: makeEntry({ climbed_at: '2026-07-24T15:14:00' }),
        showMirrorTag: false,
      }),
    );
    expect(getByText('8:14')).toBeTruthy();
  });

  it('asks for the time of day only: the day line above names the day', () => {
    render(createElement(LogbookEntryRow, { entry: makeEntry({}), showMirrorTag: false }));
    expect(formatter.options.at(-1)).toEqual({ hour: 'numeric', minute: '2-digit' });
  });

  it('round-trips a wall-clock time derived independently of any hardcoded offset', () => {
    // Builds the naive-UTC fixture FROM a known local wall-clock moment using
    // the pinned process TZ (rather than a hand-computed UTC offset), so this
    // check doesn't share a blind spot with the explicit case above.
    const localWallClock = new Date(2026, 0, 15, 21, 5, 0); // Jan 15, 9:05 PM local
    const storedNaiveUtc = localWallClock.toISOString().slice(0, 19);
    const { getByText } = render(
      createElement(LogbookEntryRow, {
        entry: makeEntry({ climbed_at: storedNaiveUtc }),
        showMirrorTag: false,
      }),
    );
    expect(getByText('21:05')).toBeTruthy();
  });
});
