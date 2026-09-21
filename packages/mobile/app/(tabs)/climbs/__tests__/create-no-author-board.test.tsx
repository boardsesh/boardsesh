// @vitest-environment jsdom
//
// The one create-route reason no other test can produce: a board whose
// `climbCreation` capability is off. Every board in the real table can author
// today (Woods gained it in #4750, spray walls exist for it), so this file stubs
// the capability lookup — which is why it lives apart from `create.test.tsx`,
// whose whole point is running against the real table.
//
// It is not dead code being tested for its own sake: the branch is what stops the
// NEXT board type that ships to a client before the editor learns about it from
// falling into #4760's dead spinner, and it is what makes the copy say "this board
// can't do that yet" rather than "your link was malformed".
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const activeBoard = vi.hoisted(() => ({ current: null as UserBoard | null | undefined }));
const router = vi.hoisted(() => ({ canGoBack: vi.fn(() => false), back: vi.fn(), replace: vi.fn() }));
const showToast = vi.hoisted(() => vi.fn());

// `tension` stands in for a future board that can't be authored on. Everything
// else about the table is passed straight through, so the Woods geometry rules
// the route also consults keep working.
vi.mock('@boardsesh/board-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-config')>();
  return {
    ...actual,
    getBoardCapabilities: (boardName: string | undefined) => ({
      ...actual.getBoardCapabilities(boardName),
      climbCreation: boardName?.toLowerCase() !== 'tension',
    }),
  };
});

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeParams.current,
  useRouter: () => router,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));

vi.mock('../../../../src/components/create-climb/CreateClimbScreen', () => ({
  CreateClimbScreen: () => createElement('div', { 'data-editor': 'true' }),
}));

vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));

vi.mock('../../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.current, isPending: activeBoard.current === undefined }),
}));

vi.mock('../../../../src/lib/create-climb-screen-key', () => ({
  createClimbScreenKey: () => 'key',
}));

const { default: CreateClimbRoute } = await import('../create');

const KILTER_ACTIVE_BOARD = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
} as unknown as UserBoard;

const TENSION_ACTIVE_BOARD = {
  boardType: 'tension',
  layoutId: 8,
  sizeId: 25,
  setIds: '20,21',
  angle: 40,
} as unknown as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  routeParams.current = {};
  activeBoard.current = null;
  router.canGoBack.mockReturnValue(false);
});

describe('CreateClimbRoute on a board that cannot be authored on', () => {
  it('leaves a link naming it, without silently swapping in the active board', () => {
    routeParams.current = { boardName: 'tension', layoutId: '8', sizeId: '25', setIds: '20,21', angle: '40' };
    activeBoard.current = KILTER_ACTIVE_BOARD;

    const { container } = render(<CreateClimbRoute />);

    expect(container.querySelector('[data-editor]')).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(showToast).toHaveBeenCalledWith('createClimbForm.cannotOpen.boardCannotAuthor', 'error');
  });

  it('leaves a bare open on it too, rather than spinning for ever', () => {
    activeBoard.current = TENSION_ACTIVE_BOARD;

    const { container } = render(<CreateClimbRoute />);

    expect(container.querySelector('[data-spinner]')).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(showToast).toHaveBeenCalledWith('createClimbForm.cannotOpen.boardCannotAuthor', 'error');
  });

  it('still opens on a board that can', () => {
    activeBoard.current = KILTER_ACTIVE_BOARD;

    const { container } = render(<CreateClimbRoute />);

    expect(container.querySelector('[data-editor]')).not.toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });
});
