// Several `useLogbook` instances share one board: the root board provider
// fetches the climb list's ticks in batches, and the play drawer mounts its own
// instance for the single climb it shows. These tests pin what they share: the
// fetched-uuid marker, and a batch answering a later single-climb request.

import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useLogbook } from '../use-logbook';
import type { ExecuteHttp } from '../adapter';
import { accumulatedLogbookQueryKey, fetchedLogbookClimbUuidsQueryKey } from '../logbook-keys';
import { createWrapper } from './test-helpers';

function serverTick(uuid: string, climbUuid: string) {
  return {
    uuid,
    climbUuid,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: null,
    difficulty: null,
    comment: '',
    climbedAt: '2026-05-30T00:00:00.000Z',
  };
}

type TicksVariables = { input: { climbUuids: string[] } };

// Answers GET_TICKS with one send per requested climb, except `climb-empty`.
function mockTicksTransport() {
  const executeHttp = vi.fn(async (_document: unknown, variables: TicksVariables) => ({
    ticks: variables.input.climbUuids
      .filter((climbUuid) => climbUuid !== 'climb-empty')
      .map((climbUuid) => serverTick(`tick-${climbUuid}`, climbUuid)),
  }));
  const requestedClimbUuids = () => executeHttp.mock.calls.map(([, variables]) => variables.input.climbUuids);
  return { executeHttp: executeHttp as unknown as ExecuteHttp, requestedClimbUuids };
}

const LIST_BATCH = ['climb-1', 'climb-2', 'climb-empty'];
const DRAWER_CLIMB = ['climb-1'];
const DRAWER_EMPTY_CLIMB = ['climb-empty'];
const DRAWER_OTHER_CLIMB = ['climb-9'];

describe('useLogbook (shared)', () => {
  it('reports a climb another instance fetched in a batch, and sends no second request for it', async () => {
    const { executeHttp, requestedClimbUuids } = mockTicksTransport();
    const { wrapper } = createWrapper({ executeHttp });

    const list = renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true));
    expect(requestedClimbUuids()).toEqual([LIST_BATCH]);

    const drawer = renderHook(() => useLogbook('kilter', DRAWER_CLIMB), { wrapper });

    // Fetched on the very first render: the drawer never shows a spinner for it.
    expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(true);
    expect(drawer.result.current.logbook.map((entry) => entry.uuid)).toContain('tick-climb-1');
    await act(async () => {});
    expect(requestedClimbUuids()).toEqual([LIST_BATCH]);
  });

  it('answers for a batch climb with no ticks without asking again', async () => {
    const { executeHttp, requestedClimbUuids } = mockTicksTransport();
    const { wrapper } = createWrapper({ executeHttp });

    const list = renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-empty')).toBe(true));

    const drawer = renderHook(() => useLogbook('kilter', DRAWER_EMPTY_CLIMB), { wrapper });
    expect(drawer.result.current.fetchedUuids.has('climb-empty')).toBe(true);
    await act(async () => {});
    expect(requestedClimbUuids()).toEqual([LIST_BATCH]);
  });

  it('tells every instance about a climb one of them fetched', async () => {
    const { executeHttp } = mockTicksTransport();
    const { wrapper } = createWrapper({ executeHttp });

    const list = renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true));
    expect(list.result.current.fetchedUuids.has('climb-9')).toBe(false);

    renderHook(() => useLogbook('kilter', DRAWER_OTHER_CLIMB), { wrapper });

    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-9')).toBe(true));
    expect(list.result.current.logbook.map((entry) => entry.uuid)).toContain('tick-climb-9');
  });

  it('re-reads a batch climb once the logbook was invalidated, without dropping it from the fetched set', async () => {
    const { executeHttp, requestedClimbUuids } = mockTicksTransport();
    const { wrapper, queryClient } = createWrapper({ executeHttp });

    const list = renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true));
    list.unmount();

    // A tick drained or pulled: every `['logbook']` read is stale from here.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['logbook'] });
    });

    const drawer = renderHook(() => useLogbook('kilter', DRAWER_CLIMB), { wrapper });
    expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(true);
    await waitFor(() => expect(requestedClimbUuids()).toEqual([LIST_BATCH, DRAWER_CLIMB]));
  });

  it('drops the fetched set with the accumulated rows, for every instance', async () => {
    const { executeHttp, requestedClimbUuids } = mockTicksTransport();
    const { wrapper, queryClient } = createWrapper({ executeHttp });

    const list = renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true));
    // "Fetched, no history" is the state that logs a repeat ascent as a flash
    // (#3940), so no render may report the climb fetched without its rows.
    const fetchedWithoutRows: boolean[] = [];
    const drawer = renderHook(
      () => {
        const drawerLogbook = useLogbook('kilter', DRAWER_CLIMB);
        fetchedWithoutRows.push(
          drawerLogbook.fetchedUuids.has('climb-1') &&
            !drawerLogbook.logbook.some((entry) => entry.climb_uuid === 'climb-1'),
        );
        return drawerLogbook;
      },
      { wrapper },
    );
    expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(true);

    // What `useInvalidateLogbook` does.
    act(() => {
      queryClient.removeQueries({ queryKey: ['logbook', 'kilter'] });
    });

    expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(false);
    expect(list.result.current.fetchedUuids.has('climb-1')).toBe(false);

    // Both instances ask again, and the marker comes back with the rows.
    await waitFor(() => expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(true));
    expect(drawer.result.current.logbook.map((entry) => entry.uuid)).toContain('tick-climb-1');
    expect(requestedClimbUuids().length).toBeGreaterThan(1);
    expect(fetchedWithoutRows).not.toContain(true);
  });

  it('drops the fetched set of a board no instance is mounted on', async () => {
    const { executeHttp } = mockTicksTransport();
    const { wrapper, queryClient } = createWrapper({ executeHttp });

    const list = renderHook(({ boardName }: { boardName: 'kilter' | 'tension' }) => useLogbook(boardName, LIST_BATCH), {
      wrapper,
      initialProps: { boardName: 'kilter' },
    });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true));

    list.rerender({ boardName: 'tension' });
    // The other board's climbs are not this board's: nothing reads as fetched.
    expect(list.result.current.fetchedUuids.has('climb-1')).toBe(false);
    expect(queryClient.getQueryData(fetchedLogbookClimbUuidsQueryKey('kilter'))).toBeDefined();

    act(() => {
      queryClient.removeQueries({ queryKey: accumulatedLogbookQueryKey('kilter'), exact: true });
    });

    expect(queryClient.getQueryData(fetchedLogbookClimbUuidsQueryKey('kilter'))).toBeUndefined();
  });

  it('drops the fetched set when the whole cache is cleared at sign-out', async () => {
    const { executeHttp } = mockTicksTransport();
    const { wrapper, queryClient } = createWrapper({ executeHttp });

    const list = renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true));
    list.unmount();

    act(() => {
      queryClient.clear();
    });

    expect(queryClient.getQueryData(fetchedLogbookClimbUuidsQueryKey('kilter'))).toBeUndefined();
    expect(queryClient.getQueryData(accumulatedLogbookQueryKey('kilter'))).toBeUndefined();
  });
});
