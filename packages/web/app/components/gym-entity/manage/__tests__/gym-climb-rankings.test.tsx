import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  GET_CLIMB,
  GET_GYM_CLIMB_RANKINGS,
  GET_GYM_CLIMB_RANKING_TARGET,
  GET_SPRAY_CLIMB,
  GET_SPRAY_WALL_BY_LAYOUT,
  GET_SPRAY_WALL_RENDER_DATA,
} from '@boardsesh/graphql';
import type { GymClimbRankingMode, GymClimbRankings } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { revokeWebPrivacySnapshots } from '@/app/lib/privacy-client';
import { GymClimbRankingsPanel } from '../gym-climb-rankings';
import { readGymClimbRankingPreview } from '../gym-climb-ranking-preview';

const mocks = vi.hoisted(() => ({ request: vi.fn(), client: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string | readonly string[]) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/app/hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'v' }) }));
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: (token: string) => {
    mocks.client(token);
    return { request: mocks.request };
  },
}));

const row: GymClimbRankings['rows'][number] = {
  rank: 1,
  physicalBoardUuid: 'wall-uuid',
  boardName: 'Training corner',
  target: {
    logicalBoardUuid: 'wall-uuid',
    boardSlug: 'staff-only-wall',
    boardType: 'spray',
    layoutId: 501,
    sizeId: 501,
    setIds: '502',
    climbUuid: '743b809e-9011-4eab-9d6b-25c293baa645',
    name: 'Private finish',
    angle: 50,
    isMirror: false,
    referenceDifficulty: null,
    shareable: false,
  },
  sendCount: 10,
  senderCount: 5,
  qualityMean: null,
  voterCount: null,
  commentCount: null,
  authorCount: null,
  gradeDelta: null,
  firstKnownAvailableAt: null,
  lastSendAt: null,
  lastSendEndAt: null,
  lastSendDate: null,
  knownLifetimeDays: null,
  knownWindowDays: null,
  sendsPerDay: null,
};
const ranked: GymClimbRankings = {
  status: 'READY',
  mode: 'MOST_SENT',
  rows: [row],
  startAt: '2026-11-16T21:00:00Z',
  asOf: '2026-11-23T21:00:00Z',
  timeZone: 'America/Denver',
  timeZoneConfigured: true,
  quietAvailable: true,
  truncated: false,
  nextCursor: null,
};

type Request = { document: string; variables: { input?: { mode?: GymClimbRankingMode } } };

function PreviewHarness({ boardUuid = 'wall-uuid' }: { boardUuid?: string }) {
  const [mode, setMode] = useState<GymClimbRankingMode>('MOST_SENT');
  return (
    <GymClimbRankingsPanel
      viewerId="staff"
      gymUuid="canonical-gym"
      overviewGymUuid="old-gym"
      token="staff-token"
      boardUuid={boardUuid}
      period="week"
      mode={mode}
      chooseMode={setMode}
    />
  );
}

afterEach(() => {
  mocks.request.mockReset();
  mocks.client.mockReset();
  vi.restoreAllMocks();
});

describe('staff climb ranking drill-through', () => {
  it('shows a restricted spray climb from authenticated wall art in the manage dialog', async () => {
    const signedPhoto = 'https://object-store.example/private-wall.webp?signature=temporary';
    const wall = { uuid: 'wall-uuid', board: { angle: 50 }, currentVersion: { number: 4 } };
    mocks.request.mockImplementation(({ document }: Request) => {
      if (document === GET_GYM_CLIMB_RANKINGS) return Promise.resolve({ gymClimbRankings: ranked });
      if (document === GET_GYM_CLIMB_RANKING_TARGET) return Promise.resolve({ gymClimbRankingTarget: row.target });
      if (document === GET_SPRAY_CLIMB)
        return Promise.resolve({
          climb: { uuid: row.target.climbUuid, angle: 50, frames: 'p1r1' },
        });
      if (document === GET_SPRAY_WALL_BY_LAYOUT) return Promise.resolve({ sprayWallByLayout: wall });
      if (document === GET_SPRAY_WALL_RENDER_DATA)
        return Promise.resolve({
          sprayWallRenderData: {
            wall,
            versionNumber: 4,
            boardWidth: 400,
            boardHeight: 300,
            homography: [2, 0, 0, 0, 2, 0, 0, 0, 1],
            photo: { url: signedPhoto, width: 400, height: 300 },
            holds: [
              { id: 1, cx: 100, cy: 100, r: 12 },
              { id: 2, cx: 200, cy: 100, r: 12 },
            ],
          },
        });
      return Promise.reject(new Error('Unexpected operation'));
    });
    const popup = vi.spyOn(window, 'open').mockReturnValue(null);
    const client = createTestQueryClient();
    render(
      <QueryClientProvider client={client}>
        <PreviewHarness />
      </QueryClientProvider>,
    );

    const climbRow = await screen.findByRole('button', { name: /Private finish/ });
    expect(climbRow.textContent).toContain('Training corner · 50° · Original');
    fireEvent.click(climbRow);
    const dialog = await screen.findByRole('dialog', { name: 'Private finish' });
    const photo = within(dialog).getByRole('img', { name: 'Private finish' });
    expect(photo.getAttribute('src')).toBe(signedPhoto);
    const rings = photo.parentElement?.querySelectorAll('svg circle');
    const projectedCentersAndRadii = Array.from(rings ?? [], (ring) => [
      ring.getAttribute('cx'),
      ring.getAttribute('cy'),
      ring.getAttribute('r'),
    ]);
    expect(projectedCentersAndRadii).toEqual([
      ['50', '50', '6'],
      ['50', '50', '6'],
    ]);
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(popup).not.toHaveBeenCalled();
    expect(mocks.client).toHaveBeenCalledWith('staff-token');
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        document: GET_GYM_CLIMB_RANKING_TARGET,
        variables: {
          input: {
            gymUuid: 'canonical-gym',
            boardUuid: 'wall-uuid',
            period: 'week',
            logicalBoardUuid: 'wall-uuid',
            climbUuid: row.target.climbUuid,
            angle: 50,
            isMirror: false,
          },
        },
      }),
    );
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        document: GET_SPRAY_CLIMB,
        variables: {
          boardName: 'spray',
          layoutId: 501,
          sizeId: 501,
          setIds: '502',
          angle: 50,
          climbUuid: row.target.climbUuid,
        },
      }),
    );
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        document: GET_SPRAY_WALL_BY_LAYOUT,
        variables: { layoutId: 501 },
      }),
    );
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        document: GET_SPRAY_WALL_RENDER_DATA,
        variables: { uuid: 'wall-uuid', version: 4 },
      }),
    );
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((query) => query.meta?.persist === false),
    ).toBe(true);
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((query) => !JSON.stringify(query.state.data)?.includes(signedPhoto)),
    ).toBe(true);

    await act(async () => {
      mocks.request.mockRejectedValue({ response: { status: 403 } });
      await revokeWebPrivacySnapshots(client);
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Private finish')).toBeNull();
  });

  it.each([1, 2])('rejects a refinement published after preview read %s', async (publishAfter) => {
    const signal = new AbortController().signal;
    let reads = 0;
    mocks.request.mockImplementation(({ document, variables }) => {
      const currentVersion = reads++ < publishAfter ? 4 : 5;
      const wall = {
        uuid: row.target.logicalBoardUuid,
        currentVersion: { number: currentVersion },
        board: { angle: 50 },
      };
      if (document === GET_SPRAY_WALL_BY_LAYOUT) return Promise.resolve({ sprayWallByLayout: wall });
      if (document === GET_SPRAY_CLIMB) {
        return Promise.resolve({
          climb: { uuid: row.target.climbUuid, angle: 50, frames: currentVersion === 4 ? 'p1r1' : 'p2r1' },
        });
      }
      if (document === GET_SPRAY_WALL_RENDER_DATA) {
        return Promise.resolve({
          sprayWallRenderData: {
            wall,
            versionNumber: variables.version,
            boardWidth: 400,
            boardHeight: 300,
            homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            photo: { url: 'https://private.invalid/fresh', width: 400, height: 300 },
            holds: [{ id: variables.version === 4 ? 1 : 2, cx: 70, cy: 80, r: 5 }],
          },
        });
      }
      return Promise.reject(new Error('Unexpected preview operation'));
    });
    await expect(readGymClimbRankingPreview('staff-token', row.target, signal)).rejects.toThrow(
      'Ranking wall is unavailable',
    );
    expect(mocks.request.mock.calls.map(([request]) => request.document)).toEqual([
      GET_SPRAY_WALL_BY_LAYOUT,
      GET_SPRAY_CLIMB,
      GET_SPRAY_WALL_RENDER_DATA,
    ]);
    expect(mocks.request).toHaveBeenLastCalledWith({
      document: GET_SPRAY_WALL_RENDER_DATA,
      variables: { uuid: row.target.logicalBoardUuid, version: 4 },
      signal,
    });
  });

  it('uses only the freshly verified named LED route and mirror fragment for a shareable variant', async () => {
    const catalogue = {
      ...row.target,
      boardType: 'tension',
      angle: 35,
      isMirror: true,
      shareable: true,
      boardSlug: 'named-wall',
    };
    mocks.request.mockImplementation(({ document }: Request) => {
      if (document === GET_GYM_CLIMB_RANKINGS)
        return Promise.resolve({
          gymClimbRankings: { ...ranked, rows: [{ ...row, target: catalogue }] },
        });
      if (document === GET_GYM_CLIMB_RANKING_TARGET)
        return Promise.resolve({
          gymClimbRankingTarget: { ...catalogue, boardSlug: 'fresh-wall' },
        });
      return Promise.reject(new Error('Unexpected operation'));
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <PreviewHarness />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Private finish/ }));
    const link = await screen.findByRole('link', { name: 'Open climb in a new tab' });
    expect(link.getAttribute('href')).toBe(`/b/fresh-wall/35/view/private-finish-${catalogue.climbUuid}#mirrored`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(mocks.request.mock.calls.map(([request]) => request.document)).not.toContain(GET_CLIMB);
  });
});
