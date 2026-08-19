// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

const deferred = vi.hoisted(() => ({
  ready: false,
  calls: [] as Array<{ active: boolean; resetKey: string | number | undefined }>,
}));

const flags = vi.hoisted(() => ({ boardseshGrade: false }));

const boardseshGradeQuery = vi.hoisted(() => ({
  calls: [] as Array<{ boardName: string; climbUuid: string | null; angle: number; enabled: boolean | undefined }>,
  data: undefined as unknown,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@boardsesh/board-react', () => ({ useLogbook: () => ({ logbook: [], isLoading: false }) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ brandColors: { primary: '#000' } }) }));

vi.mock('../../../hooks/use-deferred-after-interactions', () => ({
  useDeferredAfterInteractions: (active: boolean, resetKey?: string | number) => {
    deferred.calls.push({ active, resetKey });
    return deferred.ready;
  },
}));

vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({
    title,
    children,
    onHeaderLayout,
  }: {
    title: string;
    children?: ReactNode;
    onHeaderLayout?: (height: number) => void;
  }) => {
    onHeaderLayout?.(44);
    return createElement('section', { 'data-title': title }, children);
  },
}));

// SetterNotesSection renders through the real component (its suppression rules
// are what these tests assert), so only the leaf Text needs a DOM stand-in.
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('p', { 'data-testid': 'text' }, children),
}));

vi.mock('../BetaVideosSection', () => ({
  BetaVideosSection: () => createElement('div', { 'data-testid': 'beta-videos' }),
}));

vi.mock('../LogbookSection', () => ({
  LogbookSection: () => createElement('div', { 'data-testid': 'logbook' }),
}));

vi.mock('../CommunitySection', () => ({
  CommunitySection: () => createElement('div', { 'data-testid': 'community' }),
}));

vi.mock('../SimilarClimbsSection', () => ({
  SimilarClimbsSection: () => createElement('div', { 'data-testid': 'similar-climbs' }),
}));

vi.mock('../BoardseshGradeSection', () => ({
  BoardseshGradeSection: () => createElement('div', { 'data-testid': 'boardsesh-grade' }),
}));

vi.mock('../../../providers/feature-flags-provider', () => ({
  useBoardseshGradeEnabled: () => flags.boardseshGrade,
}));

vi.mock('../../../lib/graphql/hooks', () => ({
  useBoardseshGrade: (boardName: string, climbUuid: string | null, angle: number, options?: { enabled?: boolean }) => {
    boardseshGradeQuery.calls.push({ boardName, climbUuid, angle, enabled: options?.enabled });
    return { data: boardseshGradeQuery.data };
  },
  useClimbStatsHistory: () => ({ data: undefined }),
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v_grade' }),
}));

import { DeferredSections } from '../DeferredSections';

const climb = {
  uuid: 'climb-1',
  userAscents: 0,
  userAttempts: 0,
  quality_average: '3',
  ascensionist_count: 0,
} as Climb;

function renderSections(options: { enabled?: boolean; contentEnabled?: boolean; description?: string | null } = {}) {
  return render(
    <DeferredSections
      climb={options.description === undefined ? climb : ({ ...climb, description: options.description } as Climb)}
      boardName="kilter"
      layoutId={1}
      sizeId={10}
      setIds="1,2"
      angle={40}
      enabled={options.enabled ?? true}
      contentEnabled={options.contentEnabled ?? false}
      onSimilarClimbPress={vi.fn()}
    />,
  );
}

describe('DeferredSections', () => {
  beforeEach(() => {
    deferred.ready = false;
    deferred.calls = [];
    flags.boardseshGrade = false;
    boardseshGradeQuery.calls = [];
    boardseshGradeQuery.data = undefined;
  });

  it('keeps the Logbook eager (the scroll hint) while heavier sections wait for scroll and interaction readiness', () => {
    renderSections({ contentEnabled: false });

    expect(screen.getByTestId('logbook')).not.toBeNull();
    expect(screen.queryByTestId('beta-videos')).toBeNull();
    expect(screen.queryByTestId('community')).toBeNull();
    expect(screen.queryByTestId('similar-climbs')).toBeNull();
    expect(deferred.calls.at(-1)).toEqual({ active: false, resetKey: 'climb-1' });
  });

  it('still waits for the interaction defer after the content is requested', () => {
    renderSections({ contentEnabled: true });

    expect(screen.getByTestId('logbook')).not.toBeNull();
    expect(screen.queryByTestId('beta-videos')).toBeNull();
    expect(deferred.calls.at(-1)).toEqual({ active: true, resetKey: 'climb-1' });
  });

  it('renders the heavier sections once both gates are open', () => {
    deferred.ready = true;
    renderSections({ contentEnabled: true });

    expect(screen.getByTestId('logbook')).not.toBeNull();
    expect(screen.getByTestId('beta-videos')).not.toBeNull();
    expect(screen.getByTestId('community')).not.toBeNull();
    expect(screen.getByTestId('similar-climbs')).not.toBeNull();
  });

  it('hides the Boardsesh grade section when the flag is off', () => {
    deferred.ready = true;
    flags.boardseshGrade = false;
    renderSections({ contentEnabled: true });

    expect(screen.queryByTestId('boardsesh-grade')).toBeNull();
  });

  it('shows the Boardsesh grade section when the flag is on', () => {
    deferred.ready = true;
    flags.boardseshGrade = true;
    renderSections({ contentEnabled: true });

    expect(screen.getByTestId('boardsesh-grade')).not.toBeNull();
  });

  // #4494. The notes sit BELOW the Logbook on purpose: PlayDrawer's
  // `firstScreenReserve` / `computeLogbookScrollTarget` both assume the Logbook
  // is the first section rendered here, so anything inserted above it silently
  // breaks the fold math and the expand-into-view scroll.
  describe("the setter's notes", () => {
    function sectionTitles(container: HTMLElement): string[] {
      return [...container.querySelectorAll('section')].map((node) => node.getAttribute('data-title') ?? '');
    }

    it('renders the notes for a climb with real prose', () => {
      deferred.ready = true;
      const { container } = renderSections({ contentEnabled: true, description: 'Match the rail, then send.' });

      expect(container.textContent).toContain('Match the rail, then send.');
      expect(sectionTitles(container)).toContain('mobile.setterNotes.title');
    });

    it('keeps the Logbook first and puts the notes directly after it', () => {
      deferred.ready = true;
      const { container } = renderSections({ contentEnabled: true, description: 'Match the rail, then send.' });

      expect(sectionTitles(container).slice(0, 2)).toEqual(['mobile.logbook.title', 'mobile.setterNotes.title']);
    });

    it('leaves the Logbook first when there are no notes to show', () => {
      deferred.ready = true;
      const { container } = renderSections({ contentEnabled: true, description: '' });

      expect(sectionTitles(container)[0]).toBe('mobile.logbook.title');
    });

    it('renders no section at all for an empty or bare no-match description', () => {
      for (const description of ['', 'No match', 'No match\n', 'No matching.', 'no matching']) {
        deferred.ready = true;
        const { container, unmount } = renderSections({ contentEnabled: true, description });

        expect(sectionTitles(container)).not.toContain('mobile.setterNotes.title');
        unmount();
      }
    });

    it('never eats setter beta that merely mentions matching', () => {
      deferred.ready = true;
      const prose = 'No Houdini swap, spin around pls:). No matching.';
      const { container } = renderSections({ contentEnabled: true, description: prose });

      expect(container.textContent).toContain(prose);
    });

    it('waits for the interaction defer like the other below-fold sections', () => {
      deferred.ready = false;
      const { container } = renderSections({ contentEnabled: true, description: 'Match the rail, then send.' });

      expect(container.textContent).not.toContain('Match the rail, then send.');
    });
  });

  it('renders nothing while disabled', () => {
    const { container } = renderSections({ enabled: false, contentEnabled: true });

    expect(container.childElementCount).toBe(0);
  });
});
