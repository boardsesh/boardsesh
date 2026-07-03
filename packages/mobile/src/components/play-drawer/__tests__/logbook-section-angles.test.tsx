// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';

// react-native isn't satisfiable under jsdom; stub the surface the section touches.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode } & Record<string, unknown>) => createElement('div', null, children),
  ActivityIndicator: () => createElement('i', null),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Counts render as `key:count`; the recap template keys interpolate their
    // pre-translated segments like the real en-US catalog so joining is exercised.
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts.count === 'number') return `${key}:${opts.count}`;
      const templates: Record<string, string> = {
        'mobile.logbook.lifetimeRecap': '{{tries}} {{sessions}}',
        'mobile.logbook.lifetimeRecapWithSends': '{{tries}} {{sessions}} · {{sends}}',
      };
      const template = templates[key];
      if (template && opts) {
        return Object.entries(opts).reduce(
          (rendered, [name, value]) => rendered.replace(`{{${name}}}`, String(value)),
          template,
        );
      }
      return key;
    },
  }),
}));

// Capture stub: records each row's props so the angle-chip passthrough is
// assertable without rendering the real row.
const rows = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('../LogbookEntryRow', () => ({
  LogbookEntryRow: (props: Record<string, unknown>) => {
    rows.props.push(props);
    return createElement('div', null);
  },
}));

const logbookState = vi.hoisted(() => ({ logbook: [] as unknown[], isLoading: false }));
vi.mock('@boardsesh/board-react', () => ({
  useLogbook: () => logbookState,
}));

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
    climbed_at: '2026-06-01T12:00:00.000Z',
    is_ascent: true,
    status: 'send',
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    ...overrides,
  } as LogbookEntry;
}

function renderSection() {
  return render(
    createElement(LogbookSection, {
      climbUuid: 'climb-1',
      boardName: 'kilter',
      userAscents: null,
      userAttempts: null,
    }),
  );
}

beforeEach(() => {
  rows.props = [];
  logbookState.logbook = [];
  logbookState.isLoading = false;
});

describe('LogbookSection — per-angle section headers', () => {
  it('renders one header per angle, steepest first, with the lifetime recap', () => {
    logbookState.logbook = [
      makeEntry({
        uuid: 'a',
        angle: 40,
        tries: 4,
        status: 'attempt',
        is_ascent: false,
        climbed_at: '2026-06-01T10:00:00',
      }),
      // 40° holds the NEWEST activity; 45° must still lead (steepest first).
      makeEntry({ uuid: 'b', angle: 40, tries: 3, status: 'send', climbed_at: '2026-06-22T10:00:00' }),
      makeEntry({
        uuid: 'c',
        angle: 45,
        tries: 2,
        status: 'attempt',
        is_ascent: false,
        climbed_at: '2026-06-20T10:00:00',
      }),
    ];
    const { container } = renderSection();
    const text = container.textContent ?? '';

    // Steepest angle (45°) leads regardless of recency; its recap has no sends part.
    const fortyFiveAt = text.indexOf('45°');
    const fortyAt = text.indexOf('40°');
    expect(fortyFiveAt).toBeGreaterThanOrEqual(0);
    expect(fortyAt).toBeGreaterThan(fortyFiveAt);

    // 40° lifetime: 7 tries over 2 sessions · 1 send. 45°: 2 tries, 1 session, no sends.
    expect(text).toContain('mobile.logbook.lifetimeTries:7 mobile.logbook.lifetimeSessions:2');
    expect(text).toContain('mobile.logbook.lifetimeSends:1');
    expect(text).toContain('mobile.logbook.lifetimeTries:2 mobile.logbook.lifetimeSessions:1');
    // Exactly one sends fragment — the sendless 45° recap must omit it.
    expect(text.match(/lifetimeSends/g)).toHaveLength(1);
  });

  it('drops the per-row angle chip under the headers and buckets rows by angle', () => {
    logbookState.logbook = [
      makeEntry({ uuid: 'a', angle: 40, climbed_at: '2026-06-21T10:00:00' }),
      makeEntry({ uuid: 'b', angle: 45, climbed_at: '2026-06-20T10:00:00' }),
    ];
    renderSection();
    expect(rows.props).toHaveLength(2);
    expect(rows.props.every((rowProps) => rowProps.showAngleChip === false)).toBe(true);
    // Steepest-first section order governs row order, not recency (40° is newer).
    const rowAngles = rows.props.map((rowProps) => (rowProps.entry as LogbookEntry).angle);
    expect(rowAngles).toEqual([45, 40]);
  });
});
