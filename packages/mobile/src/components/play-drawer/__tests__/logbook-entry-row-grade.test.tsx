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
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#abcdef',
  DEFAULT_GRADE_COLOR: '#000000',
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  // Mirrors the real formatter: null id → null (pill hidden), else "V<id>".
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

describe('LogbookEntryRow grade pill', () => {
  it('renders the grade the climber gave when difficulty is set', () => {
    const { getByText } = renderRow({ difficulty: 5 });
    expect(getByText('V5')).toBeTruthy();
  });

  it('hides the grade pill when no personal grade was logged', () => {
    const { queryByText } = renderRow({ difficulty: null });
    // The only V-grade-shaped text would be the pill; its absence means hidden.
    expect(queryByText(/^V\d+$/)).toBeNull();
  });
});

describe('LogbookEntryRow result', () => {
  it('reads a send as "sent in N" with its tries and the check mark', () => {
    const { container } = renderRow({ status: 'send', tries: 3 });
    expect(container.textContent).toContain('mobile.logbook.entrySentIn:3');
    expect(container.querySelector('[data-icon="check.small"]')).not.toBeNull();
  });

  it('reads a flash as a flash, with no try count', () => {
    const { container } = renderRow({ status: 'flash', tries: 1 });
    expect(container.textContent).toContain('mobile.logbook.entryFlash');
    expect(container.textContent).not.toContain('mobile.logbook.entrySentIn');
    expect(container.querySelector('[data-icon="flash"]')).not.toBeNull();
  });

  it('reads an attempt as its tries', () => {
    const { container } = renderRow({ status: 'attempt', is_ascent: false, tries: 4 });
    expect(container.textContent).toContain('mobile.logbook.tries:4');
    expect(container.querySelector('[data-icon="minus"]')).not.toBeNull();
  });

  it('floors an imported zero-try tick at one', () => {
    const { container } = renderRow({ status: 'attempt', is_ascent: false, tries: 0 });
    expect(container.textContent).toContain('mobile.logbook.tries:1');
  });

  it('reads an entry with no status but is_ascent as a send', () => {
    const { container } = renderRow({ status: undefined, is_ascent: true, tries: 2 });
    expect(container.textContent).toContain('mobile.logbook.entrySentIn:2');
  });
});

describe('LogbookEntryRow stars', () => {
  const starLabel = (container: HTMLElement) =>
    container.querySelector('[aria-label^="mobile.logbook.starsA11y"]')?.getAttribute('aria-label') ?? null;

  it('shows the star number on a send', () => {
    const { container } = renderRow({ status: 'send', quality: 4 });
    expect(starLabel(container)).toBe('mobile.logbook.starsA11y:4');
  });

  it('shows none on an attempt, even when a rating exists', () => {
    const { container } = renderRow({ status: 'attempt', is_ascent: false, quality: 4, effectiveQuality: 4 });
    expect(starLabel(container)).toBeNull();
  });

  it('prefers the effective quality when the tick has none of its own', () => {
    const { container } = renderRow({ status: 'send', quality: null, effectiveQuality: 3 });
    expect(starLabel(container)).toBe('mobile.logbook.starsA11y:3');
  });
});

describe('LogbookEntryRow note', () => {
  it('prints the note', () => {
    const { getByText } = renderRow({ comment: 'Heel on the start jug.' });
    expect(getByText('Heel on the start jug.')).toBeTruthy();
  });
});

describe('LogbookEntryRow direction tags', () => {
  it.each([false, true])('labels direction explicitly (mirrored=%s)', (isMirror) => {
    const { container } = renderRow({ is_mirror: isMirror }, true);
    expect(container.textContent).toContain(isMirror ? 'mobile.logbook.mirroredTag' : 'mobile.logbook.originalTag');
  });
  it('omits direction labels when mirroring is unsupported', () => {
    const { container } = renderRow({ is_mirror: true }, false);
    expect(container.textContent).not.toMatch(/mobile.logbook.(originalTag|mirroredTag)/);
  });
});
