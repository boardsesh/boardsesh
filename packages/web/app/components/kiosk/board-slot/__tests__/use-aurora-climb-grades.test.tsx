import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BoardPresenceClimb, BoardPresenceClimbGrade } from '@boardsesh/shared-schema';
import { BOARD_PRESENCE_CLIMB_GRADES } from '@boardsesh/graphql/operations';
import { useAuroraClimbGrades } from '../use-aurora-climb-grades';

const execute = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({ executeGraphQL: execute }));

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  execute.mockReset();
});
afterEach(() => queryClient.clear());

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
function climb(uuid: string, source: BoardPresenceClimb['source'] = 'aurora'): BoardPresenceClimb {
  return { climbUuid: uuid, source, angle: null, grade: null, sentAt: '2026-11-17T12:00:00.123456Z', seq: 1 };
}
function grade(uuid: string, difficulty: string): BoardPresenceClimbGrade {
  return { uuid, difficulty, boardseshDifficulty: null, boardseshConfidence: null };
}

describe('kiosk Aurora grade projection', () => {
  it('keeps native and Kilter rows unchanged without requesting grades', () => {
    const native = climb('native', 'boardsesh');
    const kilter = climb('kilter', 'kilter');
    const { result } = renderHook(
      () => useAuroraClimbGrades({ boardId: 7, angle: 40, climb: native, lastLitClimb: kilter }),
      { wrapper },
    );
    expect(result.current.climb).toBe(native);
    expect(result.current.lastLitClimb).toBe(kilter);
    expect(execute).not.toHaveBeenCalled();
  });

  it('batches current and last-lit UUIDs with the configured angle and unlisted-wall link proof', async () => {
    const current = climb('alias-current');
    const last = climb('last');
    execute.mockResolvedValue({ boardPresenceClimbGrades: [grade('alias-current', '7a/V6'), grade('last', '6c/V5')] });
    const { result } = renderHook(
      () =>
        useAuroraClimbGrades({
          boardId: 7,
          boardUuid: 'wall-link',
          angle: 40,
          climb: current,
          lastLitClimb: last,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.climb?.grade).toBe('7a/V6'));
    expect(result.current.lastLitClimb).toMatchObject({ angle: 40, grade: '6c/V5' });
    expect(execute).toHaveBeenCalledExactlyOnceWith(BOARD_PRESENCE_CLIMB_GRADES, {
      boardId: 7,
      boardUuid: 'wall-link',
      angle: 40,
      climbUuids: ['alias-current', 'last'],
    });
    expect(current).toMatchObject({ angle: null, grade: null });
    expect(last).toMatchObject({ angle: null, grade: null });
  });

  it('retains selected zero degrees for an idle wall last-lit row', async () => {
    const last = climb('last');
    execute.mockResolvedValue({ boardPresenceClimbGrades: [grade('last', '4a/V0')] });
    const { result } = renderHook(
      () =>
        useAuroraClimbGrades({
          boardId: 7,
          angle: 0,
          climb: null,
          lastLitClimb: last,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.lastLitClimb?.grade).toBe('4a/V0'));
    expect(result.current.climb).toBeNull();
    expect(result.current.lastLitClimb?.angle).toBe(0);
  });

  it('deduplicates one occurrence used in both identity rows', async () => {
    const current = climb('current');
    execute.mockResolvedValue({ boardPresenceClimbGrades: [grade('current', '6c/V5')] });
    renderHook(() => useAuroraClimbGrades({ boardId: 7, angle: 40, climb: current, lastLitClimb: current }), {
      wrapper,
    });
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0][1].climbUuids).toEqual(['current']);
  });

  it('does not apply a late response from the old angle to the new angle', async () => {
    let finishOld!: (response: { boardPresenceClimbGrades: BoardPresenceClimbGrade[] }) => void;
    const current = climb('current');
    execute.mockImplementation((_document: string, variables: { angle: number }) =>
      variables.angle === 40
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve({ boardPresenceClimbGrades: [grade('current', '7b/V8')] }),
    );
    const { result, rerender } = renderHook(
      ({ angle }) =>
        useAuroraClimbGrades({
          boardId: 7,
          angle,
          climb: current,
          lastLitClimb: null,
        }),
      { wrapper, initialProps: { angle: 40 } },
    );
    await waitFor(() => expect(finishOld).toBeDefined());
    rerender({ angle: 50 });
    await waitFor(() => expect(result.current.climb).toMatchObject({ angle: 50, grade: '7b/V8' }));
    await act(async () => {
      finishOld({ boardPresenceClimbGrades: [grade('current', '6c/V5')] });
    });
    expect(result.current.climb).toMatchObject({ angle: 50, grade: '7b/V8' });
  });
});
