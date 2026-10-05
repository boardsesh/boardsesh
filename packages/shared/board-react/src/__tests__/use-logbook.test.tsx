// Several `useLogbook` instances share one board: the root board provider
// fetches the climb list's ticks in batches, and the play drawer mounts its own
// instance for the single climb it shows. These tests pin what they share: the
// fetched-uuid marker, and a batch answering a later single-climb request.

import type { ReactNode } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { useLogbook } from '../use-logbook';
import { BoardAdapterProvider, type BoardAdapter, type ExecuteHttp } from '../adapter';
import { accumulatedLogbookQueryKey, fetchLogbookQueryKey, fetchedLogbookClimbUuidsQueryKey } from '../logbook-keys';
import type { LogbookEntry } from '../logbook-keys';
import { createTestQueryClient, createWrapper } from './test-helpers';

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
// `addTick` logs another one from elsewhere, `clearTicks` empties the account,
// and `hold` keeps every later answer back until the returned release is called.
function mockTicksTransport() {
  const extraTicks: Array<{ uuid: string; climbUuid: string }> = [];
  let hasTicks = true;
  let held: Promise<void> | null = null;
  const executeHttp = vi.fn(async (_document: unknown, variables: TicksVariables) => {
    if (held) await held;
    const requested = variables.input.climbUuids;
    return {
      ticks: hasTicks
        ? [
            ...requested
              .filter((climbUuid) => climbUuid !== 'climb-empty')
              .map((climbUuid) => serverTick(`tick-${climbUuid}`, climbUuid)),
            ...extraTicks
              .filter((tick) => requested.includes(tick.climbUuid))
              .map((tick) => serverTick(tick.uuid, tick.climbUuid)),
          ]
        : [],
    };
  });
  return {
    executeHttp: executeHttp as unknown as ExecuteHttp,
    requestedClimbUuids: () => executeHttp.mock.calls.map(([, variables]) => variables.input.climbUuids),
    addTick: (uuid: string, climbUuid: string) => extraTicks.push({ uuid, climbUuid }),
    clearTicks: () => {
      hasTicks = false;
    },
    hold: () => {
      let release = () => {};
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        held = null;
        release();
      };
    },
  };
}

const uuidsOf = (entries: LogbookEntry[] | undefined) => (entries ?? []).map((entry) => entry.uuid);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LIST_BATCH = ['climb-1', 'climb-2', 'climb-empty'];
const DRAWER_CLIMB = ['climb-1'];
const DRAWER_EMPTY_CLIMB = ['climb-empty'];
const DRAWER_OTHER_CLIMB = ['climb-9'];

describe('useLogbook (shared)', () => {
  // #6023: GetTicks cannot select Tick.climbRevision while the screenshot
  // fixtures pin its text, so the platform's local copy supplies it.
  it('joins the platform’s local tick versions onto a fetched batch, in one read', async () => {
    const { executeHttp } = mockTicksTransport();
    const readLocalTickRevisions = vi.fn(async () => new Map([['tick-climb-2', 3]]));
    const { wrapper } = createWrapper({ executeHttp, readLocalTickRevisions });

    const list = renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-2')).toBe(true));

    expect(readLocalTickRevisions).toHaveBeenCalledTimes(1);
    expect(readLocalTickRevisions).toHaveBeenCalledWith('kilter', LIST_BATCH);
    const byUuid = new Map(list.result.current.logbook.map((entry) => [entry.uuid, entry]));
    expect(byUuid.get('tick-climb-2')?.climb_revision).toBe(3);
    expect(byUuid.get('tick-climb-1')?.climb_revision).toBeUndefined();
  });

  it('keeps the rows when the local version read fails', async () => {
    const { executeHttp } = mockTicksTransport();
    const readLocalTickRevisions = vi.fn(async () => {
      throw new Error('database is locked');
    });
    const { wrapper } = createWrapper({ executeHttp, readLocalTickRevisions });

    const drawer = renderHook(() => useLogbook('kilter', DRAWER_CLIMB), { wrapper });
    await waitFor(() => expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(true));

    expect(uuidsOf(drawer.result.current.logbook)).toEqual(['tick-climb-1']);
    expect(drawer.result.current.error).toBeNull();
  });

  it('skips the local read for a batch with no ticks', async () => {
    const { executeHttp } = mockTicksTransport();
    const readLocalTickRevisions = vi.fn(async () => new Map<string, number>());
    const { wrapper } = createWrapper({ executeHttp, readLocalTickRevisions });

    const drawer = renderHook(() => useLogbook('kilter', DRAWER_EMPTY_CLIMB), { wrapper });
    await waitFor(() => expect(drawer.result.current.fetchedUuids.has('climb-empty')).toBe(true));

    expect(readLocalTickRevisions).not.toHaveBeenCalled();
  });

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

  it.each([
    ['with a tick logged elsewhere in it', true],
    ['with the same rows as before', false],
  ])(
    'after an invalidation the root batch is read again, and its answer %s serves the drawer with no request',
    async (_label, tickLoggedElsewhere) => {
      const { executeHttp, requestedClimbUuids, addTick } = mockTicksTransport();
      const { wrapper, queryClient } = createWrapper({ executeHttp });

      const list = renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
      await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true));
      const singleClimbKey = fetchLogbookQueryKey('kilter', DRAWER_CLIMB);
      const filedAt = queryClient.getQueryState(singleClimbKey)?.dataUpdatedAt ?? 0;

      if (tickLoggedElsewhere) addTick('tick-elsewhere', 'climb-1');
      await pause(5);
      // The batch is on screen, so the invalidation refetches it. The drawer's
      // single-climb entry is stale until that answer lands, then re-dated by it.
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['logbook'] });
      });
      await waitFor(() => expect(queryClient.getQueryState(singleClimbKey)?.dataUpdatedAt).toBeGreaterThan(filedAt));
      expect(queryClient.getQueryState(singleClimbKey)?.isInvalidated).toBe(false);
      expect(requestedClimbUuids()).toEqual([LIST_BATCH, LIST_BATCH]);

      const drawer = renderHook(() => useLogbook('kilter', DRAWER_CLIMB), { wrapper });
      expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(true);
      await act(async () => {});
      expect(requestedClimbUuids()).toEqual([LIST_BATCH, LIST_BATCH]);
      expect(uuidsOf(drawer.result.current.logbook).includes('tick-elsewhere')).toBe(tickLoggedElsewhere);
    },
  );

  it('does not put a batch answer over a newer single-climb answer for the same climb', async () => {
    const { executeHttp, requestedClimbUuids, addTick } = mockTicksTransport();
    const { wrapper, queryClient } = createWrapper({ executeHttp });
    const singleClimbKey = fetchLogbookQueryKey('kilter', DRAWER_CLIMB);

    renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
    await waitFor(() => expect(queryClient.getQueryData(singleClimbKey)).toBeDefined());

    // The climb is then fetched alone, later, and the server has more to say.
    act(() => {
      queryClient.removeQueries({ queryKey: singleClimbKey, exact: true });
    });
    addTick('tick-later', 'climb-1');
    await pause(5);
    renderHook(() => useLogbook('kilter', DRAWER_CLIMB), { wrapper });
    await waitFor(() => expect(uuidsOf(queryClient.getQueryData(singleClimbKey))).toContain('tick-later'));
    expect(requestedClimbUuids()).toEqual([LIST_BATCH, DRAWER_CLIMB]);

    // The rows go, and the list hook merges its cached (older) batch again.
    act(() => {
      queryClient.removeQueries({ queryKey: accumulatedLogbookQueryKey('kilter'), exact: true });
    });
    await act(async () => {});

    expect(uuidsOf(queryClient.getQueryData(singleClimbKey))).toContain('tick-later');
    // Climbs nobody fetched alone are still filed from the batch.
    expect(uuidsOf(queryClient.getQueryData(fetchLogbookQueryKey('kilter', ['climb-2'])))).toEqual(['tick-climb-2']);
  });

  it('does not file a batch that was invalidated after it was fetched', async () => {
    const { executeHttp, hold } = mockTicksTransport();
    const { wrapper, queryClient } = createWrapper({ executeHttp });
    const singleClimbKey = fetchLogbookQueryKey('kilter', DRAWER_CLIMB);

    const list = renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true));
    list.unmount();
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['logbook'] });
    });

    // The list comes back: it reads the stale batch from the cache while its
    // refetch is out. The climb's own entry must stay stale until that lands.
    const release = hold();
    renderHook(() => useLogbook('kilter', LIST_BATCH), { wrapper });
    await act(async () => {});
    expect(queryClient.getQueryState(singleClimbKey)?.isInvalidated).toBe(true);

    await act(async () => release());
    await waitFor(() => expect(queryClient.getQueryState(singleClimbKey)?.isInvalidated).toBe(false));
  });
});

// "Fetched, no history" is the state that logs a repeat ascent as a flash
// (#3940). The marker is shared, so it must never be readable without the rows
// it speaks for. The first three tests fail with
// `ensureMarkerIsRemovedWithRows` taken out.
describe('useLogbook: the fetched set never outlives the accumulated rows', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('with hooks mounted: no render reports a climb fetched while its rows are gone', async () => {
    const { executeHttp } = mockTicksTransport();
    const { wrapper, queryClient } = createWrapper({ executeHttp });

    // Watched on both instances: whichever renders first after the removal is
    // the one a surviving marker would mislead.
    const fetchedWithoutRows: boolean[] = [];
    const watch = (climbUuids: string[]) => () => {
      const watched = useLogbook('kilter', climbUuids);
      fetchedWithoutRows.push(
        watched.fetchedUuids.has('climb-1') && !watched.logbook.some((entry) => entry.climb_uuid === 'climb-1'),
      );
      return watched;
    };
    const list = renderHook(watch(LIST_BATCH), { wrapper });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true));
    const drawer = renderHook(watch(DRAWER_CLIMB), { wrapper });
    const rendersBefore = fetchedWithoutRows.length;

    // Only the rows are removed. The fetch answers stay cached, so the hooks
    // merge them straight back: rows first, then the marker.
    act(() => {
      queryClient.removeQueries({ queryKey: accumulatedLogbookQueryKey('kilter'), exact: true });
    });
    await waitFor(() => expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(true));
    expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true);

    expect(fetchedWithoutRows.length).toBeGreaterThan(rendersBefore);
    expect(fetchedWithoutRows).not.toContain(true);
  });

  it('with no hook mounted on that board: the marker goes with the rows', async () => {
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

  it('when the rows are garbage-collected while something still holds the marker', async () => {
    const { executeHttp } = mockTicksTransport();
    const { wrapper, queryClient } = createWrapper({ executeHttp });
    const markerKey = fetchedLogbookClimbUuidsQueryKey('kilter');

    const list = renderHook(({ boardName }: { boardName: 'kilter' | 'tension' }) => useLogbook(boardName, LIST_BATCH), {
      wrapper,
      initialProps: { boardName: 'kilter' },
    });
    await waitFor(() => expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true));
    // An observer that keeps the marker out of garbage collection on its own.
    const releaseMarker = new QueryObserver(queryClient, { queryKey: markerKey, enabled: false }).subscribe(() => {});

    vi.useFakeTimers();
    // Leaving the board drops the last observer of its rows and starts the timer.
    list.rerender({ boardName: 'tension' });
    expect(queryClient.getQueryData(accumulatedLogbookQueryKey('kilter'))).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(6 * 60 * 1000);
    });

    expect(queryClient.getQueryState(accumulatedLogbookQueryKey('kilter'))).toBeUndefined();
    expect(queryClient.getQueryData(markerKey)).toBeUndefined();
    releaseMarker();
  });

  it('across a sign-out with hooks mounted: the next account never reads a climb as fetched before its own answer', async () => {
    const { executeHttp, clearTicks, hold } = mockTicksTransport();
    const queryClient = createTestQueryClient();
    const session = { isAuthenticated: true };
    const wrapper = ({ children }: { children: ReactNode }) => {
      const adapter: BoardAdapter = {
        isAuthenticated: session.isAuthenticated,
        isAuthLoading: false,
        executeHttp,
        executeWs: async () => {
          throw new Error('executeWs not configured for this test');
        },
        resolveActiveSessionId: () => undefined,
      };
      return (
        <QueryClientProvider client={queryClient}>
          <BoardAdapterProvider value={adapter}>{children}</BoardAdapterProvider>
        </QueryClientProvider>
      );
    };

    // The probe climb has NO ticks for the second account, so "fetched" with an
    // empty history is exactly what a stale marker would look like.
    const probe = { secondAccount: false, answered: false };
    const fetchedBeforeAnswer: boolean[] = [];
    const firstAccountRows: boolean[] = [];
    const watch = (climbUuids: string[]) => () => {
      const watched = useLogbook('kilter', climbUuids);
      if (probe.secondAccount) {
        fetchedBeforeAnswer.push(watched.fetchedUuids.has('climb-1') && !probe.answered);
        firstAccountRows.push(watched.logbook.some((entry) => entry.uuid === 'tick-climb-1'));
      }
      return watched;
    };
    const list = renderHook(watch(LIST_BATCH), { wrapper });
    const drawer = renderHook(watch(DRAWER_CLIMB), { wrapper });
    await waitFor(() => expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(true));
    expect(uuidsOf(drawer.result.current.logbook)).toContain('tick-climb-1');

    // Sign-out, as the app does it: the adapter flips and the cache is cleared.
    session.isAuthenticated = false;
    list.rerender();
    drawer.rerender();
    act(() => {
      queryClient.clear();
    });

    // Somebody else signs in. They have never logged anything.
    clearTicks();
    const release = hold();
    probe.secondAccount = true;
    session.isAuthenticated = true;
    list.rerender();
    drawer.rerender();
    await act(async () => {});
    expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(false);

    probe.answered = true;
    await act(async () => release());
    await waitFor(() => expect(drawer.result.current.fetchedUuids.has('climb-1')).toBe(true));
    expect(list.result.current.fetchedUuids.has('climb-1')).toBe(true);
    expect(drawer.result.current.logbook).toEqual([]);

    expect(fetchedBeforeAnswer.length).toBeGreaterThan(2);
    expect(fetchedBeforeAnswer).not.toContain(true);
    expect(firstAccountRows).not.toContain(true);
  });
});
