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

function renderSections(options: { enabled?: boolean; contentEnabled?: boolean } = {}) {
  return render(
    <DeferredSections
      climb={climb}
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

  it('renders nothing while disabled', () => {
    const { container } = renderSections({ enabled: false, contentEnabled: true });

    expect(container.childElementCount).toBe(0);
  });
});
