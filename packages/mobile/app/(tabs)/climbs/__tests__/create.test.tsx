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

// Real board-config: the route reads both SUPPORTED_BOARDS and the
// board-capability table, and stubbing the latter here would fork the per-board
// feature switches away from the one table this route is supposed to follow.
// The package is pure TS constants — nothing native to keep out of the test.

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

describe('CreateClimbRoute Woods authoring', () => {
  it.each(['1', '2'])('opens Woods size %s from a cold link', (sizeId) => {
    routeParams.current = { boardName: 'woods', layoutId: '1', sizeId, setIds: '1', angle: '40' };
    activeBoard.current = KILTER_ACTIVE_BOARD;
    const { container } = render(<CreateClimbRoute />);
    expect(container.querySelector('[data-editor]')).not.toBeNull();
    expect(editorBoard.latest).toMatchObject({ boardName: 'woods', sizeId: Number(sizeId) });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('leaves an incomplete Woods link instead of loading a different board', () => {
    routeParams.current = { boardName: 'woods', forkFrames: 'p0r4p1r3' };
    activeBoard.current = KILTER_ACTIVE_BOARD;
    router.canGoBack.mockReturnValue(true);
    render(<CreateClimbRoute />);
    expect(router.back).toHaveBeenCalled();
    expect(editorBoard.latest).toBeNull();
  });

  it.each([
    { layoutId: '1', sizeId: '99', angle: '40' },
    { layoutId: '8', sizeId: '1', angle: '40' },
    { layoutId: '1', sizeId: '1', angle: '42' },
  ])('rejects invalid Woods geometry: %j', (geometry) => {
    routeParams.current = { boardName: 'woods', setIds: '1', ...geometry };
    activeBoard.current = KILTER_ACTIVE_BOARD;
    render(<CreateClimbRoute />);
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(editorBoard.latest).toBeNull();
  });

  it('opens bare on the active Woods board', () => {
    activeBoard.current = WOODS_ACTIVE_BOARD;
    render(<CreateClimbRoute />);
    expect(editorBoard.latest).toMatchObject({ boardName: 'woods', sizeId: 1 });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('waits while the active board is still loading', () => {
    activeBoard.current = undefined;
    const { container } = render(<CreateClimbRoute />);
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });
});
