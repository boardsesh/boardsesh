import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import type { SetterPageData } from '../server-setter-data';

const state = vi.hoisted(() => ({
  configs: (async () => []) as () => Promise<PopularBoardConfig[]>,
  dataDelayMs: 0,
}));

vi.mock('server-only', () => ({}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}));
vi.mock('@/app/lib/server-popular-configs', () => ({ getAllBoardConfigsOrThrow: () => state.configs() }));
vi.mock('../server-setter-data', () => ({
  getSetterPageData: async (): Promise<SetterPageData> => {
    if (state.dataDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.dataDelayMs));
    return {
      username: 'marco',
      climbs: [
        {
          uuid: 'abcdef1234567890abcdef1234567890',
          layoutId: 1,
          boardType: 'kilter',
          angle: 40,
          compatibleSizeIds: [10],
          requiredSetIds: [1, 20],
        },
      ],
    } as unknown as SetterPageData;
  },
}));

const { getSetterPageView, setterPageHasCrawlableClimb } = await import('../setter-page-view');

const kilterConfig: PopularBoardConfig = {
  boardType: 'kilter',
  layoutId: 1,
  layoutName: 'Kilter Board Original',
  sizeId: 10,
  sizeName: '12 x 12 with kickboard',
  sizeDescription: '12 x 12 Square',
  setIds: [1, 20],
  setNames: ['Bolt Ons', 'Screw Ons'],
  climbCount: 4200,
  totalAscents: 99,
  boardCount: 12,
  displayName: 'Kilter Original 12x12',
};

describe('getSetterPageView when the board catalogue is missing', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    state.dataDelayMs = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the climbs unlinked when the catalogue read rejects', async () => {
    state.configs = async () => {
      throw new Error('popularBoardConfigs unavailable');
    };
    const view = await getSetterPageView('marco', 1);
    expect(view?.linksDegraded).toBe(true);
    expect(view?.links.unlinkedClimbUuids.has('abcdef1234567890abcdef1234567890')).toBe(true);
    expect(await setterPageHasCrawlableClimb('marco', 1)).toBe(true);
  });

  it('gives up on a catalogue read that never answers', async () => {
    vi.useFakeTimers();
    state.configs = () => new Promise(() => {});
    const pending = getSetterPageView('marco', 1);
    await vi.advanceTimersByTimeAsync(3001);
    const view = await pending;
    expect(view?.linksDegraded).toBe(true);
    expect(view?.links.unlinkedClimbUuids.size).toBe(1);
  });

  it('keeps links the catalogue delivered while a slow setter read was still running', async () => {
    vi.useFakeTimers();
    state.dataDelayMs = 5000;
    state.configs = () => new Promise((resolve) => setTimeout(() => resolve([kilterConfig]), 4000));
    const pending = getSetterPageView('marco', 1);
    await vi.advanceTimersByTimeAsync(5001);
    const view = await pending;
    expect(view?.linksDegraded).toBe(false);
    expect(view?.hasCrawlableClimb).toBe(true);
  });

  it('links the climb as before when the catalogue answers', async () => {
    state.configs = async () => [kilterConfig];
    const view = await getSetterPageView('marco', 1);
    expect(view?.linksDegraded).toBe(false);
    expect(view?.hasCrawlableClimb).toBe(true);
  });
});
