// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), push: vi.fn() }));
const boardState = vi.hoisted(() => ({
  data: undefined as UserBoard | null | undefined,
  isSuccess: false,
  isError: false,
  refetch: vi.fn(),
}));
const mutations = vi.hoisted(() => ({ setBoard: vi.fn(), clearBoard: vi.fn() }));

vi.mock('expo-router', () => ({ useRouter: () => navigation }));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => boardState,
  useSetActiveBoard: () => mutations.setBoard,
  useClearActiveBoard: () => mutations.clearBoard,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Card', () => ({
  Card: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement(onPress ? 'button' : 'section', { onClick: onPress }, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));

import { BoardSummaryCard } from '../pre-session/BoardSummaryCard';
import { useSessionBoardNavigation } from '../use-session-board-navigation';

function SessionBoardActions() {
  const { boardQuery, hasNoBoard, browseClimbs, openBoardSwitcher, retryBoard } = useSessionBoardNavigation();
  return createElement(BoardSummaryCard, {
    board: boardQuery.data,
    hasNoBoard,
    isRestoreError: !boardQuery.data && boardQuery.isError,
    onBrowseClimbs: browseClimbs,
    onChangeBoard: openBoardSwitcher,
    onRetry: retryBoard,
  });
}

describe('Session board navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boardState.data = { name: 'My board', boardType: 'kilter', sizeName: '12 × 12', angle: 40 } as UserBoard;
    boardState.isSuccess = true;
    boardState.isError = false;
  });

  it('browses the already selected board without activating it again', () => {
    const { container } = render(createElement(SessionBoardActions));
    expect(screen.getByText('My board · 12 × 12 · 40°')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^mobile.session.browseClimbs/ }));
    expect(navigation.navigate).toHaveBeenCalledExactlyOnceWith('/(tabs)/climbs');
    expect(navigation.push).not.toHaveBeenCalled();
    expect(mutations.setBoard).not.toHaveBeenCalled();
    expect(mutations.clearBoard).not.toHaveBeenCalled();
    expect(container.querySelector('button button')).toBeNull();
  });

  it('keeps the full board context available to the browse action', () => {
    const boardName = 'Sharma Climbing Gavà - Kilter Board Original with a longer custom gym name';
    boardState.data = { ...boardState.data, name: boardName } as UserBoard;
    render(createElement(SessionBoardActions));
    const browse = screen.getByRole('button', { name: /^mobile.session.browseClimbs/ });
    expect(browse.textContent).toContain(boardName);
    expect(browse.getAttribute('aria-label')).toBe(`mobile.session.browseClimbs, ${boardName} · 12 × 12 · 40°`);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('changes boards through a separate action that returns to Session', () => {
    render(createElement(SessionBoardActions));
    fireEvent.click(screen.getByRole('button', { name: 'mobile.session.changeBoard' }));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { returnTo: '/(tabs)/record' },
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('offers first selection only after storage confirms no board', () => {
    boardState.data = null;
    render(createElement(SessionBoardActions));
    fireEvent.click(screen.getByRole('button', { name: 'mobile.session.chooseBoard' }));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { returnTo: '/(tabs)/climbs' },
    });
    expect(screen.queryByRole('button', { name: /^mobile.session.browseClimbs/ })).toBeNull();
  });

  it('waits for storage instead of offering a new selection', () => {
    boardState.data = undefined;
    boardState.isSuccess = false;
    render(createElement(SessionBoardActions));
    expect(screen.getByText('actions.loading')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('retries a failed restore without opening the picker or clearing the board', () => {
    boardState.data = undefined;
    boardState.isSuccess = false;
    boardState.isError = true;
    render(createElement(SessionBoardActions));
    expect(screen.getByText('mobile.emptyState.boardRestoreFailed.title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'actions.retry' }));
    expect(boardState.refetch).toHaveBeenCalledOnce();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(mutations.clearBoard).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'mobile.session.chooseBoard' })).toBeNull();
  });

  it('keeps browsing available when a refresh fails with a cached board', () => {
    boardState.isSuccess = false;
    boardState.isError = true;
    render(createElement(SessionBoardActions));
    fireEvent.click(screen.getByRole('button', { name: /^mobile.session.browseClimbs/ }));
    expect(navigation.navigate).toHaveBeenCalledExactlyOnceWith('/(tabs)/climbs');
    expect(screen.queryByRole('button', { name: 'actions.retry' })).toBeNull();
  });
});
