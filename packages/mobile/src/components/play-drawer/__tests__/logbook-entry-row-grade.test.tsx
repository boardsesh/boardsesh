// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';

// react-native isn't satisfiable under jsdom; stub the surface the row touches.
vi.mock('react-native', () => ({
  View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('div', { 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count === undefined ? key : `${key}:${opts.count}`),
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'light',
    brandColors: { primary: '#primary', primaryFill: '#primaryFill' },
    systemColors: { secondaryLabel: '#secondary', separator: '#separator' },
  }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  // Mirrors the real formatter: null id → null (no grade printed), else "V<id>".
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

const renderRow = (overrides: Partial<LogbookEntry>, showMirrorTag = false) =>
  render(createElement(LogbookEntryRow, { entry: makeEntry(overrides), showMirrorTag }));

const rowLabel = (container: HTMLElement) => container.firstElementChild?.getAttribute('aria-label') ?? '';

describe('LogbookEntryRow grade', () => {
  it('prints the grade the climber gave as plain text after the result', () => {
    const { container } = renderRow({ difficulty: 5, tries: 2 });
    expect(container.textContent).toContain('mobile.logbook.entrySentIn:2 · V5');
  });

  it('prints no grade when no personal grade was logged', () => {
    const { container } = renderRow({ difficulty: null });
    expect(container.textContent).not.toMatch(/V\d/);
  });
});

describe('LogbookEntryRow result', () => {
  it('reads a send as "sent in N" with its tries', () => {
    const { container } = renderRow({ status: 'send', tries: 3 });
    expect(container.textContent).toContain('mobile.logbook.entrySentIn:3');
  });

  it('reads a flash as a flash, with no try count', () => {
    const { container } = renderRow({ status: 'flash', tries: 1 });
    expect(container.textContent).toContain('mobile.logbook.entryFlash');
    expect(container.textContent).not.toContain('mobile.logbook.entrySentIn');
  });

  it('reads an attempt as its tries and says it did not go', () => {
    const { container } = renderRow({ status: 'attempt', is_ascent: false, tries: 4 });
    expect(container.textContent).toContain('mobile.logbook.entryNoSend:4');
  });

  it('floors an imported zero-try tick at one', () => {
    const { container } = renderRow({ status: 'attempt', is_ascent: false, tries: 0 });
    expect(container.textContent).toContain('mobile.logbook.entryNoSend:1');
  });

  it('reads an entry with no status but is_ascent as a send', () => {
    const { container } = renderRow({ status: undefined, is_ascent: true, tries: 2 });
    expect(container.textContent).toContain('mobile.logbook.entrySentIn:2');
  });

  // The words are the status: no disc, tick or bolt stands in for them.
  it.each([
    ['send', true],
    ['flash', true],
    ['attempt', false],
  ] as const)('draws no status glyph for a %s', (status, isAscent) => {
    const { container } = renderRow({ status, is_ascent: isAscent });
    expect(container.querySelector('[data-icon]')).toBeNull();
  });
});

describe('LogbookEntryRow stars', () => {
  it('prints the stars as text on a send and names them in the label', () => {
    const { container } = renderRow({ status: 'send', quality: 4 });
    expect(container.textContent).toContain(' · 4★');
    expect(rowLabel(container)).toContain('mobile.logbook.starsA11y:4');
  });

  it('prints none on an attempt, even when a rating exists', () => {
    const { container } = renderRow({ status: 'attempt', is_ascent: false, quality: 4, effectiveQuality: 4 });
    expect(container.textContent).not.toContain('★');
    expect(rowLabel(container)).not.toContain('mobile.logbook.starsA11y');
  });

  it('prefers the effective quality when the tick has none of its own', () => {
    const { container } = renderRow({ status: 'send', quality: null, effectiveQuality: 3 });
    expect(container.textContent).toContain(' · 3★');
  });
});

describe('LogbookEntryRow note', () => {
  it('prints the note', () => {
    const { getByText } = renderRow({ comment: 'Heel on the start jug.' });
    expect(getByText('Heel on the start jug.')).toBeTruthy();
  });
});

describe('LogbookEntryRow accessibility label', () => {
  it('reads the whole row in one go: result, grade, stars, direction, time, note', () => {
    const { container } = renderRow(
      { status: 'send', tries: 3, difficulty: 6, quality: 4, is_mirror: true, comment: 'Right foot high.' },
      true,
    );
    const parts = rowLabel(container).split(', ');
    expect(parts.slice(0, 4)).toEqual([
      'mobile.logbook.entrySentIn:3',
      'V6',
      'mobile.logbook.starsA11y:4',
      'mobile.logbook.mirroredTag',
    ]);
    expect(parts.at(-1)).toBe('Right foot high.');
    // The time sits between the direction and the note.
    expect(parts).toHaveLength(6);
  });

  it('leaves out what the log does not have', () => {
    const { container } = renderRow({ status: 'attempt', is_ascent: false, tries: 5 });
    expect(rowLabel(container).split(', ')).toHaveLength(2);
    expect(rowLabel(container)).toMatch(/^mobile\.logbook\.entryNoSend:5, /);
  });
});

describe('LogbookEntryRow direction tags', () => {
  it.each([false, true])('labels direction in plain text (mirrored=%s)', (isMirror) => {
    const { container } = renderRow({ is_mirror: isMirror }, true);
    expect(container.textContent).toContain(
      isMirror ? ' · mobile.logbook.mirroredTag' : ' · mobile.logbook.originalTag',
    );
  });
  it('omits direction labels when mirroring is unsupported', () => {
    const { container } = renderRow({ is_mirror: true }, false);
    expect(container.textContent).not.toMatch(/mobile.logbook.(originalTag|mirroredTag)/);
  });
});

// #6023: a log made before the climb was last edited says so, in words.
describe('LogbookEntryRow earlier version tag', () => {
  const renderVersioned = (climbRevision: number | null | undefined, climbCurrentRevision: number | null | undefined) =>
    render(
      createElement(LogbookEntryRow, {
        entry: makeEntry({ climb_revision: climbRevision }),
        showMirrorTag: false,
        climbCurrentRevision,
      }),
    );

  it('tags a log on a lower version than the climb is on now', () => {
    const { container } = renderVersioned(1, 3);

    expect(container.textContent).toContain(' · mobile.logbook.earlierVersionTag');
    expect(rowLabel(container)).toContain('mobile.logbook.earlierVersionA11y');
  });

  it('shows no tag on the current version', () => {
    const { container } = renderVersioned(3, 3);

    expect(container.textContent).not.toContain('earlierVersionTag');
    expect(rowLabel(container)).not.toContain('earlierVersionA11y');
  });

  it.each([
    ['the log has no version', null, 3],
    ['the log has no version key at all', undefined, 3],
    ['the climb’s version is unknown', 1, null],
    ['the screen passes no climb version', 1, undefined],
  ])('shows no tag when %s', (_label, climbRevision, climbCurrentRevision) => {
    const { container } = renderVersioned(climbRevision, climbCurrentRevision);

    expect(container.textContent).not.toContain('earlierVersionTag');
    expect(rowLabel(container)).not.toContain('earlierVersionA11y');
  });

  it('sits after the mirror tag, and prints no version number', () => {
    const { container } = render(
      createElement(LogbookEntryRow, {
        entry: makeEntry({ climb_revision: 8, is_mirror: true }),
        showMirrorTag: true,
        climbCurrentRevision: 9,
      }),
    );

    expect(container.textContent).toContain('mobile.logbook.mirroredTag · mobile.logbook.earlierVersionTag');
    // The row's only digits are its try count and the 12:00 clock time.
    expect(container.textContent).not.toMatch(/[89]/);
  });
});
