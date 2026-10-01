// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';

// react-native isn't satisfiable under jsdom; stub the surface the row touches.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/ascent-status-utils', () => ({
  // Echo the status so the row's success/attempt branch follows the fixture.
  normalizeAscentStatus: ({ status }: { status?: string }) => status ?? 'send',
}));
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#abcdef',
  DEFAULT_GRADE_COLOR: '#000000',
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  // Mirrors the real formatter: null id → null (chip hidden), else "V<id>".
  useGradeFormat: () => ({
    formatGradeByDifficultyId: (id: number | null | undefined) => (id == null ? null : `V${id}`),
  }),
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
    climbed_at: '2026-01-01T12:00:00.000Z',
    is_ascent: true,
    status: 'send',
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    ...overrides,
  };
}

describe('LogbookEntryRow grade chip', () => {
  it('renders the grade the climber gave when difficulty is set', () => {
    const { getByText } = render(
      createElement(LogbookEntryRow, { entry: makeEntry({ difficulty: 5 }), showMirrorTag: false }),
    );
    expect(getByText('V5')).toBeTruthy();
  });

  it('hides the grade chip when no personal grade was logged', () => {
    const { queryByText } = render(
      createElement(LogbookEntryRow, { entry: makeEntry({ difficulty: null }), showMirrorTag: false }),
    );
    // The only V-grade-shaped text would be the chip; its absence means hidden.
    expect(queryByText(/^V\d+$/)).toBeNull();
  });
});

describe('LogbookEntryRow direction tags', () => {
  it.each([false, true])('labels direction explicitly (mirrored=%s)', (isMirror) => {
    const { container } = render(
      createElement(LogbookEntryRow, {
        entry: makeEntry({ is_mirror: isMirror }),
        showMirrorTag: true,
      }),
    );
    expect(container.textContent).toContain(isMirror ? 'mobile.logbook.mirroredTag' : 'mobile.logbook.originalTag');
  });
  it('omits direction labels when mirroring is unsupported', () => {
    const { container } = render(
      createElement(LogbookEntryRow, {
        entry: makeEntry({ is_mirror: true }),
        showMirrorTag: false,
      }),
    );
    expect(container.textContent).not.toMatch(/mobile.logbook.(originalTag|mirroredTag)/);
  });
});
