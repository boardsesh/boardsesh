// @vitest-environment jsdom
//
// The one property this component exists for: it draws an OLD version of a wall
// without the spray registry ever hearing about it.
//
// The registry holds one version per wall, the current one, and the play drawer
// this sheet sits on top of draws from it. If showing a revision registered the
// old version, the photograph and the holds under the live player would swap to
// last year's wall. So the registry is real here, and every case ends by
// checking it is exactly as it was.

import { createElement, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());
const offline = vi.hoisted(() => ({ blocked: false }));

vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../../../lib/create-climb-draft-store', () => ({ clearSupersededSprayDrafts: async () => {} }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../../lib/board-render-settings', () => ({ sanitizeBoardRenderDefault: () => null }));

vi.mock('react-native', () => ({
  View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('div', { 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-image', () => ({
  Image: ({ source, cachePolicy }: { source?: { uri?: string }; cachePolicy?: string }) =>
    createElement('img', { src: source?.uri, 'data-cache-policy': cachePolicy }),
}));
vi.mock('react-native-svidg', () => ({
  default: ({ children, viewBox }: { children?: ReactNode; viewBox?: string }) =>
    createElement('svg', { 'data-viewbox': viewBox }, children),
  Path: ({ d, stroke }: { d?: string; stroke?: string }) =>
    createElement('path', { 'data-d': d, 'data-stroke': stroke }),
}));
vi.mock('../../OfflineState', () => ({
  OfflineState: ({ reason }: { reason: string }) =>
    createElement('div', { 'data-testid': 'offline', 'data-reason': reason }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#666', tertiaryBackground: '#eee' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 3: 12, 6: 24 } }));
vi.mock('../../../hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () =>
    offline.blocked
      ? { isOffline: true, isBlocked: true, reason: 'offline' }
      : { isOffline: false, isBlocked: false, reason: null },
}));

const { GET_SPRAY_WALL_RENDER_DATA } = await import('@boardsesh/graphql/operations/spray-walls');
const {
  clearSprayWallRegistry,
  getSprayWall,
  getSprayWallLoadState,
  listRegisteredSprayWalls,
  registerSprayWall,
  sprayCacheToken,
  sprayWallViewerGeneration,
  subscribeToSprayWalls,
} = await import('../../../lib/spray/spray-wall-registry');
const { SprayRevisionBoard, buildRevisionRingBuckets, sprayRevisionRenderDataQueryKey } =
  await import('../SprayRevisionBoard');
const { sprayWallRenderDataQueryKey } = await import('../../../lib/spray/spray-wall-loader');

const LAYOUT_ID = 4200;
const WALL_UUID = 'wall-uuid';

/** The wall as the session holds it: version 3, today's photo. */
function registerCurrentWall() {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: WALL_UUID,
    angle: 40,
    version: 3,
    versionId: 3,
    photoWidth: 3000,
    photoHeight: 4000,
    photoUrl: 'https://private.example/current',
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds: [{ id: 99, cx: 10, cy: 20, r: 5 }],
    viewerAccess: { canEdit: true, generation: sprayWallViewerGeneration() },
  });
}

/** Version 1 of the same wall: another photo, another set of holds. */
function oldVersionPayload(overrides: Record<string, unknown> = {}) {
  return {
    sprayWallRenderData: {
      wall: { uuid: WALL_UUID, board: { angle: 25 }, viewerCanEdit: false },
      versionNumber: 1,
      boardWidth: 1200,
      boardHeight: 1600,
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      photo: { url: 'https://private.example/old', thumbUrl: null, width: 1200, height: 1600, expiresAt: 'later' },
      holds: [
        { id: 7, cx: 100, cy: 200, r: 18, outline: null, source: 'AUTO', confidence: 0.9 },
        { id: 8, cx: 300, cy: 400, r: 18, outline: null, source: 'MANUAL', confidence: null },
      ],
      ...overrides,
    },
  };
}

function renderBoard(frames = 'p7r1p8r3') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SprayRevisionBoard wallUuid={WALL_UUID} version={1} frames={frames} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

beforeEach(() => {
  clearSprayWallRegistry();
  requestMock.mockReset();
  offline.blocked = false;
});

afterEach(() => {
  clearSprayWallRegistry();
});

describe('SprayRevisionBoard', () => {
  it('draws the old version and leaves the registry exactly as it was', async () => {
    registerCurrentWall();
    const registeredBefore = getSprayWall(LAYOUT_ID);
    let wakes = 0;
    const unsubscribe = subscribeToSprayWalls(() => {
      wakes += 1;
    });
    requestMock.mockResolvedValue(oldVersionPayload());

    const { container } = renderBoard();
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    unsubscribe();

    // It drew version 1: that photo, in that photo's own pixels.
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://private.example/old');
    expect(container.querySelector('svg')?.getAttribute('data-viewbox')).toBe('0 0 1200 1600');

    // And the session still holds version 3, untouched: the same object, the
    // same cache token, the same access flag, and not one subscriber woken.
    expect(getSprayWall(LAYOUT_ID)).toBe(registeredBefore);
    expect(getSprayWall(LAYOUT_ID)?.version).toBe(3);
    expect(getSprayWall(LAYOUT_ID)?.photoUrl).toBe('https://private.example/current');
    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(true);
    expect(sprayCacheToken('spray', LAYOUT_ID)).toBe('-svid3');
    expect(listRegisteredSprayWalls()).toHaveLength(1);
    expect(wakes).toBe(0);
  });

  it('registers nothing when no wall was registered to begin with', async () => {
    requestMock.mockResolvedValue(oldVersionPayload());

    const { container } = renderBoard();
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    expect(listRegisteredSprayWalls()).toHaveLength(0);
    expect(getSprayWallLoadState(LAYOUT_ID)).toBe('idle');
  });

  it('asks for that one version by number, under a key the live payload does not share', async () => {
    requestMock.mockResolvedValue(oldVersionPayload());

    const { container, queryClient } = renderBoard();
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(GET_SPRAY_WALL_RENDER_DATA, { uuid: WALL_UUID, version: 1 });
    // Invalidating the live payload (a reset, an expired signature, an account
    // change) must not sweep this one up, and this must never be read back as
    // the live payload.
    expect(sprayRevisionRenderDataQueryKey(WALL_UUID, 1)[0]).not.toBe(sprayWallRenderDataQueryKey(WALL_UUID)[0]);
    expect(queryClient.getQueryData(sprayWallRenderDataQueryKey(WALL_UUID))).toBeUndefined();
  });

  it('keeps the signed photo URL out of the disk cache', async () => {
    requestMock.mockResolvedValue(oldVersionPayload());
    const { container } = renderBoard();
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(container.querySelector('img')?.getAttribute('data-cache-policy')).toBe('memory');
  });

  it('rings only the holds the revision uses, grouped by role colour', async () => {
    requestMock.mockResolvedValue(oldVersionPayload());
    const { container } = renderBoard('p7r1p8r3');
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    const paths = [...container.querySelectorAll('path')];
    // Two roles, each drawn twice: a dark halo and the coloured ring over it.
    expect(paths).toHaveLength(4);
    const ringColours = new Set(paths.slice(2).map((path) => path.getAttribute('data-stroke')));
    expect(ringColours.size).toBe(2);
    expect(paths.every((path) => (path.getAttribute('data-d') ?? '').length > 0)).toBe(true);
  });

  it.each([
    ['the version no longer resolves', { sprayWallRenderData: null }],
    ['the photo will not say its size', oldVersionPayload({ photo: { url: 'x', width: null, height: null } })],
    ['the homography has no inverse', oldVersionPayload({ homography: [0, 0, 0, 0, 0, 0, 0, 0, 0] })],
  ])('says the photo is gone, in one line, when %s', async (_label, payload) => {
    registerCurrentWall();
    const registeredBefore = getSprayWall(LAYOUT_ID);
    requestMock.mockResolvedValue(payload);

    const { container } = renderBoard();

    await waitFor(() => expect(screen.getByText('mobile.revisions.sheet.photoUnavailable')).not.toBeNull());
    expect(container.querySelector('img')).toBeNull();
    // An unreadable old version must not withdraw the live wall either.
    expect(getSprayWall(LAYOUT_ID)).toBe(registeredBefore);
  });

  it('shows the offline placard, not "photo gone", with no connection', () => {
    offline.blocked = true;
    requestMock.mockReturnValue(new Promise(() => {}));

    renderBoard();

    expect(screen.getByTestId('offline').getAttribute('data-reason')).toBe('offline');
    expect(screen.queryByText('mobile.revisions.sheet.photoUnavailable')).toBeNull();
  });
});

describe('buildRevisionRingBuckets', () => {
  const holds = [
    { id: 7, cx: 100, cy: 200, r: 18 },
    { id: 8, cx: 300, cy: 400, r: 18 },
  ];

  it('skips a hold the frames name but this wall version does not have', () => {
    const buckets = buildRevisionRingBuckets('p7r1p555r1', holds);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].path).toContain('M82 200');
  });

  it('folds every frame of a route into one picture', () => {
    const single = buildRevisionRingBuckets('p7r2', holds);
    const route = buildRevisionRingBuckets('p7r2,p8r2', holds);
    expect(route).toHaveLength(1);
    expect(route[0].path.length).toBeGreaterThan(single[0].path.length);
  });

  it('draws nothing for empty frames', () => {
    expect(buildRevisionRingBuckets('', holds)).toEqual([]);
  });
});
