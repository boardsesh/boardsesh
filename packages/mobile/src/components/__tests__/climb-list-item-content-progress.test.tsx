// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';

/**
 * The rich tier's personal line, and the memo boundary that keeps it cheap.
 *
 * The load-bearing test here is the last one: a logbook merge must re-render the
 * progress line and NOTHING else. `ClimbListItemContent.tsx`'s own comments
 * record the climbs-search redesign inlining `useAscentStatus` into the row and
 * re-rendering every visible thumbnail on every tick write; this asserts the new
 * line did not reintroduce that.
 */

// A REAL context stands in for `BoardLogbookContext` (module-private in
// board-provider). That matters: a plain `vi.fn()` returning a value could not
// model context propagation, which is exactly the mechanism under test — a new
// provider value must reach the line's consumer while `ClimbListItemContent`
// itself bails out on memo.
const logbookContextRef = vi.hoisted(() => ({
  current: null as null | React.Context<{ logbookByClimbAngle: Map<string, LogbookEntry[]> } | null>,
}));

const thumbnailRenders = vi.hoisted(() => ({ count: 0 }));
const fontScale = vi.hoisted(() => ({ current: 1 }));

vi.mock('@boardsesh/board-react', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const context = React.createContext<{ logbookByClimbAngle: Map<string, LogbookEntry[]> } | null>(null);
  logbookContextRef.current = context;
  return {
    logbookClimbAngleKey: (climbUuid: string, angle: number) => `${climbUuid}:${angle}`,
    useOptionalBoardLogbook: () => React.useContext(context),
    useEffectiveClimbStats: (
      _boardName: string,
      _layoutId: number,
      _climbUuid: string,
      _angle: number,
      base: { ascensionistCount?: number; qualityAverage?: string; difficulty?: string },
    ) => ({
      ascensionistCount: base.ascensionistCount ?? 0,
      qualityAverage: base.qualityAverage ?? null,
      difficulty: base.difficulty ?? null,
    }),
  };
});

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: fontScale.current }),
}));

// Echo the key, and the count when one is interpolated, so a test can name the
// exact token it expects without depending on English copy.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count == null ? key : `${key}:${options.count}`),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ boardseshActive: false, resolveGrade: () => ({ label: 'V5', color: '#abcdef' }) }),
}));

vi.mock('../../hooks/use-is-climb-favorited', () => ({ useIsClimbFavorited: () => false }));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000000', secondaryLabel: '#8E8E93' } }),
}));

vi.mock('../../lib/format-climb-stats', () => ({ formatSends: () => 'sends', formatQuality: () => '4.5' }));

vi.mock('../Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant }, children),
}));

vi.mock('../ClimbListThumbnail', () => ({
  ClimbListThumbnail: () => {
    thumbnailRenders.count += 1;
    return null;
  },
  THUMBNAIL_WIDTH: 76,
  THUMBNAIL_HEIGHT: 96,
}));

vi.mock('../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
vi.mock('../ClimbPlaylistChips', () => ({ ClimbPlaylistChips: () => null }));

import { ClimbListItemContent } from '../ClimbListItemContent';

const climb = {
  uuid: 'c1',
  name: 'Test Climb',
  frames: 'p1r1',
  difficulty: '6b/V4',
  quality_average: '4.5',
  ascensionist_count: 10,
};

const entry = (overrides: Partial<LogbookEntry> = {}): LogbookEntry =>
  ({
    uuid: 't1',
    climb_uuid: 'c1',
    angle: 40,
    is_mirror: false,
    tries: 1,
    quality: null,
    difficulty: null,
    comment: '',
    climbed_at: new Date().toISOString().replace('Z', ''),
    is_ascent: true,
    status: 'send',
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    ...overrides,
  }) as LogbookEntry;

function logbook(entries: LogbookEntry[]) {
  const logbookByClimbAngle = new Map<string, LogbookEntry[]>();
  if (entries.length > 0) logbookByClimbAngle.set('c1:40', entries);
  return { logbookByClimbAngle };
}

function renderRow(density: 'compact' | 'default' | 'rich', entries: LogbookEntry[]) {
  const context = logbookContextRef.current;
  if (context === null) throw new Error('board-react mock did not create the logbook context');
  const row = (
    <ClimbListItemContent
      climb={climb}
      boardName="kilter"
      layoutId={1}
      sizeId={1}
      setIds="1"
      angle={40}
      density={density}
    />
  );
  const result = render(<context.Provider value={logbook(entries)}>{row}</context.Provider>);
  return {
    ...result,
    merge: (next: LogbookEntry[]) => result.rerender(<context.Provider value={logbook(next)}>{row}</context.Provider>),
  };
}

const progressText = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-variant="footnote"]'))
    .map((node) => node.textContent ?? '')
    .find((text) => text.startsWith('mobile.climbRow.progress.')) ?? null;

beforeEach(() => {
  thumbnailRenders.count = 0;
  fontScale.current = 1;
});

describe('rich-tier progress line', () => {
  it('renders nothing for a climb the climber has no history with', () => {
    const { container } = renderRow('rich', []);
    expect(progressText(container)).toBeNull();
  });

  it('renders nothing in the compact and default tiers, history or not', () => {
    expect(progressText(renderRow('compact', [entry()]).container)).toBeNull();
    expect(progressText(renderRow('default', [entry()]).container)).toBeNull();
  });

  it('leads with the outcome and closes with recency', () => {
    const { container } = renderRow('rich', [entry()]);
    expect(progressText(container)).toBe('mobile.climbRow.progress.sent · mobile.climbRow.progress.today');
  });

  it('names the mirror state when both orientations are sent (#4801)', () => {
    const { container } = renderRow('rich', [entry(), entry({ uuid: 't2', is_mirror: true })]);
    expect(progressText(container)).toBe(
      'mobile.climbRow.progress.sentTimes:2 · mobile.climbRow.progress.bothWays · mobile.climbRow.progress.today',
    );
  });

  it('omits the mirror token for an original-only send, since that is the default', () => {
    const { container } = renderRow('rich', [entry()]);
    expect(progressText(container)).not.toContain('mirror');
    expect(progressText(container)).not.toContain('bothWays');
  });

  it('carries the matching status glyph', () => {
    const { container } = renderRow('rich', [entry({ status: 'flash' })]);
    expect(container.querySelectorAll('[data-icon="flash"]').length).toBeGreaterThan(0);
  });

  it('drops tokens from the right as Dynamic Type grows', () => {
    fontScale.current = 1.15;
    expect(progressText(renderRow('rich', [entry(), entry({ uuid: 't2', is_mirror: true })]).container)).toBe(
      'mobile.climbRow.progress.sentTimes:2 · mobile.climbRow.progress.bothWays',
    );

    fontScale.current = 1.3;
    expect(progressText(renderRow('rich', [entry(), entry({ uuid: 't2', is_mirror: true })]).container)).toBe(
      'mobile.climbRow.progress.sentTimes:2',
    );
  });
});

describe('rich-tier progress line memo boundary', () => {
  it('does not re-render the thumbnail when a logbook merge lands', () => {
    const { container, merge } = renderRow('rich', []);
    expect(thumbnailRenders.count).toBe(1);
    expect(progressText(container)).toBeNull();

    merge([entry()]);

    // The line updated...
    expect(progressText(container)).toBe('mobile.climbRow.progress.sent · mobile.climbRow.progress.today');
    // ...and the board artwork did not re-render. This is the regression bar.
    expect(thumbnailRenders.count).toBe(1);
  });

  it('does not re-render the thumbnail on a merge that misses this climb', () => {
    const { merge } = renderRow('rich', [entry()]);
    expect(thumbnailRenders.count).toBe(1);
    merge([entry(), entry({ uuid: 't2', climb_uuid: 'other' })]);
    expect(thumbnailRenders.count).toBe(1);
  });
});
