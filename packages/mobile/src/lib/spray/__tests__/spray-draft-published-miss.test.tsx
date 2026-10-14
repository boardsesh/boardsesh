// @vitest-environment jsdom
// The add-a-wall look step's preview against the REAL published-wall loader.
//
// A wall being created has no published version, so every published-wall load
// of it (a photo signature refresh, a reconnect, a sign-in, My Boards asking)
// gets a null render payload. Before the draft exception that null withdrew the
// draft registration, erased its cached payload and left the look step saying
// "unavailable" for good. Real loader, real QueryClient, real draft hooks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Same seams as spray-wall-loader.test.ts: the GraphQL client pulls
// react-native's Flow source, and the draft store, photo store and error
// reporter all reach native modules.
const offlineState = vi.hoisted(() => ({ offline: false, subscribers: new Set<() => void>() }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: offlineState.offline }),
  subscribeConnectivity: (listener: () => void) => {
    offlineState.subscribers.add(listener);
    return () => offlineState.subscribers.delete(listener);
  },
  retryConnectivityNow: async () => {},
}));
vi.mock('../spray-wall-local-loader', () => ({ loadLocalSprayWall: vi.fn(async () => false) }));
const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../spray-privacy-cleanup', async () => {
  const { unregisterSprayWall: withdraw } = await import('../spray-wall-registry');
  return { clearSprayWallPrivateCaches: (layoutId: number) => withdraw(layoutId) };
});
vi.mock('../spray-photo-store', () => ({
  SPRAY_PHOTO_STORE_AVAILABLE: true,
  deleteStoredSprayPhoto: () => {},
  pruneStoredSprayPhotos: () => {},
  storeSprayPhoto: async () => null,
}));
vi.mock('../../create-climb-draft-store', () => ({ clearSupersededSprayDrafts: async () => {} }));
vi.mock('../../error-reporting', () => ({ reportHandledError: vi.fn() }));

const { clearSprayWallRegistry, getSprayWall, refreshSprayWall, sprayWallRemovalGeneration, subscribeToSprayWalls } =
  await import('../spray-wall-registry');
const { clearSprayWallArchiveAnswers, clearSprayWallLooks, installSprayWallLoader } =
  await import('../spray-wall-loader');
const { useKeepSprayDraftRegistered, useSprayWallDraft } = await import('../use-spray-wall-draft');
const sprayOperations = await import('@boardsesh/graphql/operations/spray-walls');

const LAYOUT_ID = 4300;
const WALL_UUID = 'new-wall-uuid';
const VERSION_NUMBER = 1;
const VERSION_ID = '31';

/** An initial wall's draft version: no published version, the creator can edit it. */
function draftPayload() {
  return {
    sprayWallRenderData: {
      wall: {
        uuid: WALL_UUID,
        layoutId: LAYOUT_ID,
        board: { angle: 30 },
        viewerCanEdit: true,
        currentVersion: null,
        versions: [{ id: VERSION_ID, number: VERSION_NUMBER, status: 'DRAFT' }],
      },
      versionNumber: VERSION_NUMBER,
      boardWidth: 1200,
      boardHeight: 1600,
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      photo: { url: 'https://private.example/draft', thumbUrl: null, width: 1200, height: 1600, expiresAt: 'later' },
      holds: [{ id: 7, cx: 100, cy: 200, r: 18, outline: null }],
    },
  };
}

function requestsFor(operation: unknown): number {
  return requestMock.mock.calls.filter(([called]) => called === operation).length;
}

let client: QueryClient;
let teardownLoader: () => void;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  offlineState.offline = false;
  offlineState.subscribers.clear();
  clearSprayWallRegistry();
  clearSprayWallLooks();
  clearSprayWallArchiveAnswers();
  requestMock.mockReset();
  requestMock.mockImplementation(async (operation: unknown) => {
    if (operation === sprayOperations.GET_SPRAY_WALL_BY_LAYOUT)
      return { sprayWallByLayout: { uuid: WALL_UUID, layoutId: LAYOUT_ID } };
    // Nothing is published yet: the published payload is null.
    if (operation === sprayOperations.GET_SPRAY_WALL_RENDER_DATA) return { sprayWallRenderData: null };
    if (operation === sprayOperations.GET_SPRAY_WALL_DRAFT_RENDER_DATA) return draftPayload();
    return { sprayWall: null };
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  teardownLoader = installSprayWallLoader(client);
});

afterEach(() => {
  cleanup();
  teardownLoader();
  client.clear();
  clearSprayWallRegistry();
});

describe('a published-wall load of a wall still being created', () => {
  it('keeps the draft preview through a forced refresh that finds nothing published', async () => {
    const { result } = renderHook(
      () => {
        const draft = useSprayWallDraft(LAYOUT_ID, WALL_UUID, VERSION_NUMBER, VERSION_ID);
        useKeepSprayDraftRegistered(LAYOUT_ID, WALL_UUID, VERSION_NUMBER, VERSION_ID);
        return draft;
      },
      { wrapper },
    );
    await waitFor(() => expect(getSprayWall(LAYOUT_ID)?.versionId).toBe(Number(VERSION_ID)));
    expect(getSprayWall(LAYOUT_ID)?.draft).toBe(true);
    const removalBefore = sprayWallRemovalGeneration(LAYOUT_ID);

    const registrySeen: (number | string | null)[] = [];
    const unsubscribe = subscribeToSprayWalls(() => {
      registrySeen.push(getSprayWall(LAYOUT_ID)?.versionId ?? null);
    });

    // An expired photo signature, a reconnect or a sign-in all land here.
    act(() => refreshSprayWall(LAYOUT_ID));
    await waitFor(() => expect(requestsFor(sprayOperations.GET_SPRAY_WALL_RENDER_DATA)).toBe(1));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    unsubscribe();

    expect(registrySeen).not.toContain(null);
    expect(getSprayWall(LAYOUT_ID)?.versionId).toBe(Number(VERSION_ID));
    expect(sprayWallRemovalGeneration(LAYOUT_ID)).toBe(removalBefore);
    expect(result.current.isUnavailable).toBe(false);
    expect(result.current.wall?.versionId).toBe(Number(VERSION_ID));
    expect(requestsFor(sprayOperations.GET_SPRAY_WALL_DRAFT_RENDER_DATA)).toBeLessThanOrEqual(2);
  });
});
