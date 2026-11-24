import { describe, expect, it } from 'vite-plus/test';
import type { GymReachOverview, GymReachWindow, GymStats } from '@boardsesh/shared-schema';
import { gymReachCards, gymReachTrend } from '../gym-reporting-overview';

const baseWindow = (climbers: number, sends: number): GymReachWindow => ({
  climbers: { count: climbers, coverage: 'complete' },
  firstRecorded: { count: climbers, coverage: 'complete' },
  sends: { count: sends, coverage: 'complete' },
  sendLoggers: 1,
  sessions: { count: sends, coverage: 'complete' },
  uncertainFirstRecorded: 0,
});
const overview: GymReachOverview = {
  observationStartedAt: '2026-01-01T00:00:00Z',
  baselineStartAt: '2026-06-01T00:00:00Z',
  current: baseWindow(6, 10),
  previous: baseWindow(4, 0),
  cameBack: { returning: 2, previousClimbers: 4, coverage: 'complete' },
  previousCameBack: { returning: 1, previousClimbers: 4, coverage: 'complete' },
  weeklyTrend: [
    {
      startDate: '2026-10-19',
      endDate: '2026-10-25',
      inProgress: false,
      climbers: { count: 0, coverage: 'unavailable' },
      sends: { count: 0, coverage: 'complete' },
    },
    {
      startDate: '2026-10-26',
      endDate: '2026-11-01',
      inProgress: true,
      climbers: { count: 5, coverage: 'partial' },
      sends: { count: 3, coverage: 'complete' },
    },
  ],
};
const stats = { timeZone: 'America/Denver', previous: { startAt: '2026-06-08T00:00:00Z' } } as GymStats;
const translation = (key: string, args?: Record<string, string>) => [key, ...Object.values(args ?? {})].join(' ');

describe('gym reach display model', () => {
  it('takes count and return-rate deltas with a truthful baseline', () => {
    const [climbers, , returned, sends] = gymReachCards(stats, overview, 'en-US', translation);
    expect(climbers.comparison).toBe('gymReach.countComparison +2 +50%');
    expect(sends.comparison).toBe('gymReach.compareZero');
    expect(returned.value).toBe('50%');
    expect(returned.comparison).toBe('gymReach.rateComparison +25 +100%');
  });

  it('shows available first classification without a comparison, and withholds a partial return rate', () => {
    const partial: GymReachOverview = {
      ...overview,
      current: { ...overview.current, firstRecorded: { count: 5, coverage: 'partial' }, uncertainFirstRecorded: 1 },
      cameBack: { ...overview.cameBack, coverage: 'partial' },
    };
    const [, first, returned] = gymReachCards(stats, partial, 'en-US', translation);
    expect(first.value).toBe('5');
    expect(first.comparison).toBe('gymReach.compareHistory');
    expect(first.note).toBe('gymReach.firstUncertain 1');
    expect(returned.description).toBe('gymReach.returnedDefinition 2 4');
    expect(returned.value).toBe('gymReach.noValue');
    expect(returned.comparison).toBe('gymReach.returnHistory');
  });

  it('preserves a missing week separately from a zero and gives exact week details', () => {
    const climbers = gymReachTrend(overview.weeklyTrend, 'climbers', null, 'en-US', translation);
    const sends = gymReachTrend(overview.weeklyTrend, 'sends', '2026-10-19', 'en-US', translation);
    expect(climbers.bars[0]).toMatchObject({ fraction: 0, coverage: 'gymReach.missing' });
    expect(climbers.selected?.accessibilityLabel).toBe(
      'gymReach.weekDetail Oct 26, 2026 Nov 1, 2026 gymReach.weekClimbers 5. gymReach.inProgress. gymReach.partial',
    );
    expect(sends.selected?.accessibilityLabel).toContain('gymReach.weekSends 0');
    expect(sends.selected?.coverage).toBeNull();
  });
});
