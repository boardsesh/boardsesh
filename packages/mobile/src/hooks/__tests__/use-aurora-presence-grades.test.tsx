// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { useAuroraPresenceGrades } from '../use-aurora-presence-grades';

const http = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => http }));
vi.mock('../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ boardId: 42, boardUuid: 'wall-key' }),
}));

const imported: BoardPresenceClimb = {
  source: 'aurora',
  climbUuid: 'climb',
  seq: 1,
  sentAt: '2026-11-17T00:00:00Z',
  angle: null,
  grade: null,
};
const climbs = [imported];
const config = { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 20 };

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe('Aurora presence grades', () => {
  beforeEach(() => {
    http.request.mockReset();
    http.request.mockImplementation(async (_query: string, variables: { angle: number }) => ({
      boardPresenceClimbGrades: [
        { uuid: 'climb', difficulty: variables.angle === 0 ? '6a' : variables.angle === 20 ? '6b' : '7a' },
      ],
    }));
  });

  it('uses the selected angle for grade reads, including zero, without changing source history', async () => {
    const { result, rerender } = renderHook(
      ({ angle }) => useAuroraPresenceGrades(climbs, { ...config, angle }, { boardId: 42, boardUuid: 'wall-key' }),
      {
        initialProps: { angle: 20 },
        wrapper,
      },
    );
    await waitFor(() => expect(result.current.get('climb')?.difficulty).toBe('6b'));
    rerender({ angle: 45 });
    await waitFor(() => expect(result.current.get('climb')?.difficulty).toBe('7a'));
    rerender({ angle: 0 });
    await waitFor(() => expect(result.current.get('climb')?.difficulty).toBe('6a'));
    expect(http.request.mock.calls.map((call) => call[1].angle)).toEqual([20, 45, 0]);
    expect(http.request.mock.calls[0][1]).toMatchObject({
      boardId: 42,
      boardUuid: 'wall-key',
      angle: 20,
      climbUuids: ['climb'],
    });
    expect(imported).toMatchObject({ angle: null, grade: null });
  });

  it('indexes returned grades by the requested alias UUID', async () => {
    http.request.mockResolvedValue({ boardPresenceClimbGrades: [{ uuid: 'requested-alias', difficulty: '7b' }] });
    const aliasClimbs = [{ ...imported, climbUuid: 'requested-alias' }];
    const { result } = renderHook(() => useAuroraPresenceGrades(aliasClimbs, config, { boardId: 42 }), { wrapper });
    await waitFor(() => expect(result.current.get('requested-alias')?.difficulty).toBe('7b'));
  });

  it('does not read grades for native/Kilter history or without a selected board', () => {
    renderHook(() => useAuroraPresenceGrades([{ ...imported, source: 'kilter' }], config, { boardId: 42 }), {
      wrapper,
    });
    renderHook(() => useAuroraPresenceGrades(climbs, null, { boardId: 42 }), { wrapper });
    expect(http.request).not.toHaveBeenCalled();
  });
});
