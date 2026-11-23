import { describe, expect, it } from 'vite-plus/test';
import type { GymReportingBoard, GymStats } from '@boardsesh/shared-schema';
import {
  formatGymReportingDate,
  formatGymReportingObservationWindow,
  GYM_REPORTING_RECEIPT_MS,
  gymReportingAliasSources,
  gymReportingAliasTargets,
  gymReportingCountDelta,
  gymReportingHasActivity,
  gymReportingQueryKey,
  gymReportingReadState,
} from '../gym-reporting';

const fixture = { current: { displayCount: 1, tickCount: 0 } } as GymStats;

describe('gym reporting client contract', () => {
  it('keys private reports on viewer, gym, physical board and period', () => {
    const key = gymReportingQueryKey('staff', 'gym-a', 'wall-a', 'week');
    expect(key).not.toEqual(gymReportingQueryKey('other', 'gym-a', 'wall-a', 'week'));
    expect(key).not.toEqual(gymReportingQueryKey('staff', 'gym-b', 'wall-a', 'week'));
    expect(key).not.toEqual(gymReportingQueryKey('staff', 'gym-a', 'wall-b', 'week'));
    expect(key).not.toEqual(gymReportingQueryKey('staff', 'gym-a', 'wall-a', 'quarter'));
  });

  it('requires current verification to render data and treats an access refusal as final for that snapshot', () => {
    const verified = {
      data: fixture,
      dataUpdatedAt: 2,
      now: 2,
      error: null,
      fetchStatus: 'idle',
      isFetchedAfterMount: true,
      offline: false,
    } as const;
    expect(gymReportingReadState(verified)).toBe('ready');
    expect(gymReportingReadState({ ...verified, offline: true })).toBe('stale');
    expect(gymReportingReadState({ ...verified, isFetchedAfterMount: false, offline: true })).toBe('offline');
    expect(gymReportingReadState({ ...verified, verifiedAfter: 3 })).toBe('loading');
    expect(
      gymReportingReadState({
        ...verified,
        offline: true,
        error: { response: { errors: [{ extensions: { code: 'NOT_FOUND' } }] } },
      }),
    ).toBe('denied');
  });

  it('expires at the same exact deadline online and offline', () => {
    const receipt = {
      data: fixture,
      dataUpdatedAt: 100,
      error: null,
      fetchStatus: 'idle',
      isFetchedAfterMount: true,
    } as const;
    const expiry = receipt.dataUpdatedAt + GYM_REPORTING_RECEIPT_MS;
    expect(gymReportingReadState({ ...receipt, now: expiry - 1, offline: true })).toBe('stale');
    expect(gymReportingReadState({ ...receipt, now: expiry, offline: true })).toBe('offline');
    expect(gymReportingReadState({ ...receipt, now: expiry, offline: false })).toBe('loading');
  });

  it('uses the reporting zone and counts displays as activity', () => {
    expect(formatGymReportingDate('2026-11-01T01:00:00Z', 'America/Denver', 'en-US')).toBe('Oct 31, 2026');
    expect(gymReportingHasActivity(fixture)).toBe(true);
    expect(gymReportingCountDelta(7, 10)).toEqual({ diff: -3, direction: 'down' });
  });

  it('formats both checked boundaries in the reporting zone and keeps each unobserved source null', () => {
    const asOf = '2026-11-01T01:00:00Z';
    const observedSince = '2025-11-01T01:00:00Z';
    const observations = formatGymReportingObservationWindow(
      {
        ...fixture,
        asOf,
        timeZone: 'America/Denver',
        coverage: {
          ...fixture.coverage,
          observedSince,
          firstDisplayAt: null,
          firstTickAt: '2026-01-02T01:00:00Z',
        },
      },
      'en-US',
    );
    expect(observations.start).toMatch(/Oct 31, 2025/);
    expect(observations.end).toMatch(/Oct 31, 2026/);
    expect(observations.firstDisplay).toBeNull();
    expect(observations.firstTick).toMatch(/Jan 1, 2026/);
  });

  it('offers visible same-type roots and existing aliases without creating nested groups', () => {
    const board = (uuid: string, aliases: string[] = [], boardType = 'kilter'): GymReportingBoard => ({
      uuid,
      boardType,
      name: uuid,
      configurations: [uuid, ...aliases].map((name) => ({ uuid: name, name })),
    });
    const boards = [board('first', ['alias']), board('second'), board('spray', [], 'spray')];
    const sources = gymReportingAliasSources(boards);
    expect(sources).toEqual([
      { uuid: 'alias', name: 'alias', boardType: 'kilter', rootUuid: 'first' },
      { uuid: 'second', name: 'second', boardType: 'kilter', rootUuid: null },
    ]);
    expect(gymReportingAliasTargets(boards, sources[0]).map((target) => target.uuid)).toEqual(['second']);
  });
});
