// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const boards = [
    { uuid: 'slot-0', name: 'Starting board' },
    { uuid: 'slot-1', name: 'Next board' },
  ];
  return { boards, activeBoard: boards[0], activate: vi.fn(), reportError: vi.fn() };
});
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: state.boards }) }));
vi.mock('../../../lib/graphql/hooks', () => ({ fetchAllMyBoards: vi.fn() }));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: state.activeBoard, isPending: false }),
  useSetActiveBoard: () => state.activate,
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../config', () => ({ boardSelectors: ['Starting board', 'Next board'] }));
vi.mock('../screenshot-smoke', () => ({ reportScreenshotSmokeError: state.reportError }));
import { IntegrationBoardSetup } from '../IntegrationBoardSetup';

afterEach(cleanup);
beforeEach(() => {
  state.activeBoard = state.boards[0];
  state.activate.mockReset().mockResolvedValue(undefined);
  state.reportError.mockReset();
});
describe('integration board initialization', () => {
  it('preserves a later slot-1 selection when slot 0 was already active', () => {
    const view = render(<IntegrationBoardSetup />);
    expect(state.activate).not.toHaveBeenCalled();
    state.activeBoard = state.boards[1];
    view.rerender(<IntegrationBoardSetup />);
    expect(state.activate).not.toHaveBeenCalled();
    expect(state.reportError).not.toHaveBeenCalled();
  });

  it('selects the starting board once when another board was initially active', async () => {
    state.activeBoard = state.boards[1];
    const view = render(<IntegrationBoardSetup />);
    await act(async () => {});
    expect(state.activate).toHaveBeenCalledExactlyOnceWith(state.boards[0]);
    state.activeBoard = state.boards[0];
    view.rerender(<IntegrationBoardSetup />);
    state.activeBoard = state.boards[1];
    view.rerender(<IntegrationBoardSetup />);
    expect(state.activate).toHaveBeenCalledOnce();
  });
});
