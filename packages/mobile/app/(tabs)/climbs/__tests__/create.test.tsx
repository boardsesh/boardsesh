// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import CreateClimbRoute from '../create';

// Mutable across tests so each seeds its own deep-link params + stored board.
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const activeBoard = vi.hoisted(() => ({ current: null as UserBoard | null | undefined }));
const router = vi.hoisted(() => ({
  canGoBack: vi.fn(() => false),
  back: vi.fn(),
  replace: vi.fn(),
}));

// The board tuple the editor was handed, captured from the stubbed screen so a
// test can assert WHICH wall it opened on — the point of the fallback rules.
const editorBoard = vi.hoisted(() => ({ latest: null as null | Record<string, unknown> }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeParams.current,
  useRouter: () => router,
}));

vi.mock('@boardsesh/board-config', () => ({
  SUPPORTED_BOARDS: ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper', 'soill', 'woods'],
}));

vi.mock('../../../../src/components/create-climb/CreateClimbScreen', () => ({
  CreateClimbScreen: (props: { board: Record<string, unknown> }) => {
    editorBoard.latest = props.board;
    return createElement('div', { 'data-editor': 'true' });
  },
}));

vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));

vi.mock('../../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.current }),
}));

vi.mock('../../../../src/lib/create-climb-screen-key', () => ({
  createClimbScreenKey: (editClimbUuid: string | undefined, board: { boardName: string }) =>
    `${editClimbUuid ?? 'new'}-${board.boardName}`,
}));

// A stored Kilter board, complete enough to open the editor bare.
const KILTER_ACTIVE_BOARD = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
} as unknown as UserBoard;

const WOODS_ACTIVE_BOARD = {
  boardType: 'woods',
  layoutId: 1,
  sizeId: 1,
  setIds: '1',
  angle: 40,
} as unknown as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  routeParams.current = {};
  activeBoard.current = null;
  editorBoard.latest = null;
  router.canGoBack.mockReturnValue(false);
});

describe('CreateClimbRoute board resolution', () => {
  it('opens the editor on the board and geometry the link named', () => {
    routeParams.current = { boardName: 'tension', layoutId: '8', sizeId: '25', setIds: '20,21', angle: '40' };
    activeBoard.current = KILTER_ACTIVE_BOARD;

    const { container } = render(<CreateClimbRoute />);

    expect(container.querySelector('[data-editor]')).not.toBeNull();
    expect(editorBoard.latest).toEqual({
      boardName: 'tension',
      layoutId: 8,
      sizeId: 25,
      setIds: '20,21',
      angle: 40,
    });
  });

  it('opens bare on the active board when the link carries no params', () => {
    activeBoard.current = KILTER_ACTIVE_BOARD;

    render(<CreateClimbRoute />);

    expect(editorBoard.latest).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });
  });

  // The #3804 fallback still applies to a typo'd board name — but the geometry
  // that came with it described THAT board, so it must not ride along onto the
  // active board's wall.
  it('drops the link geometry when falling back from an unrecognised board name', () => {
    routeParams.current = { boardName: 'notaboard', layoutId: '8', sizeId: '25', setIds: '20,21', angle: '55' };
    activeBoard.current = KILTER_ACTIVE_BOARD;

    render(<CreateClimbRoute />);

    expect(editorBoard.latest).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });
  });
});

describe('CreateClimbRoute on a board that cannot have climbs set on it', () => {
  // A cold `…/climbs/create?boardName=woods` used to resolve to no board at all
  // and paint a spinner that never resolved.
  it('replaces to the climbs tab when a Woods link opens cold', () => {
    routeParams.current = { boardName: 'woods', layoutId: '1', sizeId: '1', setIds: '1', angle: '40' };
    activeBoard.current = KILTER_ACTIVE_BOARD;
    router.canGoBack.mockReturnValue(false);

    const { container } = render(<CreateClimbRoute />);

    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(router.back).not.toHaveBeenCalled();
    // Never silently swaps in the active board — the link asked for Woods.
    expect(container.querySelector('[data-editor]')).toBeNull();
    expect(editorBoard.latest).toBeNull();
  });

  it('pops back instead when there is history to pop', () => {
    routeParams.current = { boardName: 'woods' };
    activeBoard.current = KILTER_ACTIVE_BOARD;
    router.canGoBack.mockReturnValue(true);

    render(<CreateClimbRoute />);

    expect(router.back).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('leaves a bare open when the ACTIVE board is the one that cannot be set on', () => {
    activeBoard.current = WOODS_ACTIVE_BOARD;

    render(<CreateClimbRoute />);

    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(editorBoard.latest).toBeNull();
  });

  // Still loading: `data` is undefined, so there is nothing to decide on yet.
  it('waits on the spinner while the active board is still loading', () => {
    activeBoard.current = undefined;

    const { container } = render(<CreateClimbRoute />);

    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });
});
