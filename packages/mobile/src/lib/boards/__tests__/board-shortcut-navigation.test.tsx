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
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../components/Card', () => ({
  Card: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement(onPress ? 'button' : 'section', { onClick: onPress }, children),
}));
vi.mock('../../../components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../../components/PressableSurface', () => ({
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
vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({ boardWidth: 100, boardHeight: 120 }),
}));
vi.mock('../../../lib/spray/use-spray-wall-token', () => ({ useSprayWallToken: () => '' }));
vi.mock('../../../lib/spray/use-spray-wall-thumbnail', () => ({ useSprayWallThumbnail: () => null }));
vi.mock('../../../components/BoardImageNative', () => ({ BoardImageNative: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, selection: { text: 'label', checkmark: 'accent', fill: 'fill' } }),
}));

import { BoardSummaryCard } from '../../../components/boards/BoardSummaryCard';
import { useBoardShortcutNavigation } from '../use-board-shortcut-navigation';
import type { BoardReturnTo } from '../board-return-to';

function BoardActions({
  returnTo,
  returnAfterFirstPick = false,
}: {
  returnTo: BoardReturnTo;
  returnAfterFirstPick?: boolean;
}) {
  const { boardQuery, hasNoBoard, browseClimbs, openBoardSwitcher, retryBoard } = useBoardShortcutNavigation(
    returnTo,
    returnAfterFirstPick,
  );
  return createElement(BoardSummaryCard, {
    board: boardQuery.data,
    hasNoBoard,
    isRestoreError: !boardQuery.data && boardQuery.isError,
    onBrowseClimbs: browseClimbs,
    onChangeBoard: openBoardSwitcher,
    onRetry: retryBoard,
  });
}

describe('Board card navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boardState.data = {
      name: 'My board',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      sizeName: '12 × 12',
      angle: 40,
    } as UserBoard;
    boardState.isSuccess = true;
    boardState.isError = false;
  });

  it('browses the already selected board without activating it again', () => {
    const { container } = render(createElement(BoardActions, { returnTo: '/(tabs)/record' }));
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
    render(createElement(BoardActions, { returnTo: '/(tabs)/record' }));
    const browse = screen.getByRole('button', { name: /^mobile.session.browseClimbs/ });
    expect(browse.textContent).toContain(boardName);
    expect(browse.getAttribute('aria-label')).toBe(`mobile.session.browseClimbs, ${boardName} · 12 × 12 · 40°`);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('changes boards through a separate action that returns to Session', () => {
    render(createElement(BoardActions, { returnTo: '/(tabs)/record' }));
    fireEvent.click(screen.getByRole('button', { name: 'mobile.session.changeBoard' }));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { returnTo: '/(tabs)/record' },
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('comes back to Home when the change started on Home', () => {
    render(createElement(BoardActions, { returnTo: '/(tabs)/home' }));
    fireEvent.click(screen.getByRole('button', { name: 'mobile.session.changeBoard' }));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { returnTo: '/(tabs)/home' },
    });
  });

  it('sends a first pick from Home to Climbs, where the new board is', () => {
    boardState.data = null;
    render(createElement(BoardActions, { returnTo: '/(tabs)/home' }));
    fireEvent.click(screen.getByRole('button', { name: 'mobile.session.chooseBoard' }));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { returnTo: '/(tabs)/climbs' },
    });
  });

  it('offers first selection only after storage confirms no board', () => {
    boardState.data = null;
    render(createElement(BoardActions, { returnTo: '/(tabs)/record' }));
    fireEvent.click(screen.getByRole('button', { name: 'mobile.session.chooseBoard' }));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { returnTo: '/(tabs)/climbs' },
    });
    expect(screen.queryByRole('button', { name: /^mobile.session.browseClimbs/ })).toBeNull();
  });

  it('returns to a pending partner workout after the first board choice', () => {
    boardState.data = null;
    render(createElement(BoardActions, { returnTo: '/(tabs)/record', returnAfterFirstPick: true }));
    fireEvent.click(screen.getByRole('button', { name: 'mobile.session.chooseBoard' }));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { returnTo: '/(tabs)/record' },
    });
  });

  it('waits for storage instead of offering a new selection', () => {
    boardState.data = undefined;
    boardState.isSuccess = false;
    render(createElement(BoardActions, { returnTo: '/(tabs)/record' }));
    expect(screen.getByText('actions.loading')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('retries a failed restore without opening the picker or clearing the board', () => {
    boardState.data = undefined;
    boardState.isSuccess = false;
    boardState.isError = true;
    render(createElement(BoardActions, { returnTo: '/(tabs)/record' }));
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
    render(createElement(BoardActions, { returnTo: '/(tabs)/record' }));
    fireEvent.click(screen.getByRole('button', { name: /^mobile.session.browseClimbs/ }));
    expect(navigation.navigate).toHaveBeenCalledExactlyOnceWith('/(tabs)/climbs');
    expect(screen.queryByRole('button', { name: 'actions.retry' })).toBeNull();
  });
});
