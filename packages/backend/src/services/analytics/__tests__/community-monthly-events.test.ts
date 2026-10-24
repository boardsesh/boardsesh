import { describe, expect, it } from 'vitest';
import type { CommunityMonth } from '../../community-monthly-stats';
import {
  buildCommunityEmptyMonthEvents,
  buildCommunityMonthlyEvents,
  COMMUNITY_MONTHLY_DISTINCT_ID,
  COMMUNITY_MONTHLY_RANK_EVENT,
  COMMUNITY_MONTHLY_SUMMARY_EVENT,
  communityMonthlyEventTimestamp,
  communityMonthlyEventUuid,
} from '../community-monthly-events';
import { deterministicEventUuid } from '../deterministic-event-uuid';

/**
 * The community recap's wire contract: 21 events a month, padded lists, uuids
 * that make every re-emit the same events, and nothing that identifies a
 * person beyond the one allowed name.
 */

const SEPTEMBER: CommunityMonth = {
  month: '2026-09',
  complete: true,
  namesRetired: false,
  summary: {
    climbersWhoLit: 412,
    climbsLit: 9031,
    boardsLit: 188,
    gymsWithActivity: 57,
    sendsLogged: 6120,
    climbersWhoLogged: 330,
    newAccounts: 245,
  },
  topGyms: [
    { rank: 1, gymName: 'Alpha Gym', gymSlug: 'alpha-gym', climbers: 40, climbsLit: 900, boards: 3 },
    { rank: 2, gymName: 'Beta Gym', gymSlug: null, climbers: 31, climbsLit: 620, boards: 1 },
  ],
  topClimbers: [
    { rank: 1, climberName: null, sends: 140, flashes: 30, sendDays: 18 },
    { rank: 2, climberName: 'Alice D', sends: 120, flashes: 12, sendDays: 20 },
  ],
};

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function rankRows(list: 'gyms' | 'climbers') {
  return buildCommunityMonthlyEvents(SEPTEMBER).filter(
    (monthEvent) => monthEvent.event === COMMUNITY_MONTHLY_RANK_EVENT && monthEvent.properties.list === list,
  );
}

describe('Community monthly events', () => {
  it('sends one summary and exactly ten rows per list, dated to noon on the 1st', () => {
    const monthEvents = buildCommunityMonthlyEvents(SEPTEMBER);
    expect(monthEvents).toHaveLength(21);
    expect(monthEvents[0]).toEqual({
      event: COMMUNITY_MONTHLY_SUMMARY_EVENT,
      uuid: communityMonthlyEventUuid('2026-09'),
      timestamp: new Date('2026-09-01T12:00:00.000Z'),
      properties: { month: '2026-09', complete: true, ...SEPTEMBER.summary },
    });
    for (const list of ['gyms', 'climbers'] as const) {
      expect(rankRows(list).map((row) => row.properties.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
    for (const monthEvent of monthEvents)
      expect(monthEvent.timestamp).toEqual(communityMonthlyEventTimestamp('2026-09'));
    expect(COMMUNITY_MONTHLY_DISTINCT_ID).toBe('system:community-monthly');
  });

  it('pads a short list with empty rows, so a shrinking list overwrites its old rows', () => {
    const [firstGym, secondGym, thirdGym] = rankRows('gyms');
    expect(firstGym.properties).toEqual({
      month: '2026-09',
      complete: true,
      list: 'gyms',
      rank: 1,
      empty: false,
      gymName: 'Alpha Gym',
      gymSlug: 'alpha-gym',
      climbers: 40,
      climbsLit: 900,
      boards: 3,
    });
    expect(secondGym.properties).toMatchObject({ empty: false, gymSlug: null });
    expect(thirdGym.properties).toEqual({
      month: '2026-09',
      complete: true,
      list: 'gyms',
      rank: 3,
      empty: true,
      gymName: null,
      gymSlug: null,
      climbers: null,
      climbsLit: null,
      boards: null,
    });
    const [anonymousClimber, namedClimber, emptyClimber] = rankRows('climbers');
    expect(anonymousClimber.properties).toEqual({
      month: '2026-09',
      complete: true,
      list: 'climbers',
      rank: 1,
      empty: false,
      climberName: null,
      named: false,
      sends: 140,
      flashes: 30,
      sendDays: 18,
    });
    expect(namedClimber.properties).toMatchObject({ climberName: 'Alice D', named: true });
    expect(emptyClimber.properties).toEqual({
      month: '2026-09',
      complete: true,
      list: 'climbers',
      rank: 3,
      empty: true,
      climberName: null,
      named: null,
      sends: null,
      flashes: null,
      sendDays: null,
    });
  });

  it('keys every event by month, list and rank, the same on every re-emit', () => {
    const first = buildCommunityMonthlyEvents(SEPTEMBER).map((monthEvent) => monthEvent.uuid);
    const reemit = buildCommunityMonthlyEvents({
      ...SEPTEMBER,
      complete: false,
      topGyms: [],
      topClimbers: [],
    }).map((monthEvent) => monthEvent.uuid);
    expect(reemit).toEqual(first);
    expect(new Set(first).size).toBe(21);
    for (const uuid of first) expect(uuid).toMatch(UUID_V5);
    expect(buildCommunityMonthlyEvents({ ...SEPTEMBER, month: '2026-10' })[0].uuid).not.toBe(first[0]);
    // Pinned: changing a name would stop every later run collapsing into the rows already sent.
    expect(communityMonthlyEventUuid('2026-09')).toBe('7f67dbec-c2c2-5eda-87e6-260609b4b5bd');
    expect(communityMonthlyEventUuid('2026-09', 'climbers', 3)).toBe('e88ebd8a-116b-5172-96ee-2df80b8278a8');
  });

  it('never names anyone in a retired month, even when handed names', () => {
    const climberRows = buildCommunityMonthlyEvents({ ...SEPTEMBER, namesRetired: true }).filter(
      (monthEvent) => monthEvent.properties.list === 'climbers',
    );
    expect(climberRows).toHaveLength(10);
    for (const monthEvent of climberRows) expect(monthEvent.properties.climberName).toBeNull();
    expect(climberRows.slice(0, 2).map((monthEvent) => monthEvent.properties)).toEqual([
      expect.objectContaining({ rank: 1, empty: false, named: false, sends: 140 }),
      expect.objectContaining({ rank: 2, empty: false, named: false, sends: 120 }),
    ]);
    // Gym rows are not people's names: unchanged.
    expect(
      buildCommunityMonthlyEvents({ ...SEPTEMBER, namesRetired: true }).find(
        (monthEvent) => monthEvent.properties.list === 'gyms' && monthEvent.properties.rank === 1,
      )?.properties.gymName,
    ).toBe('Alpha Gym');
  });

  it('sends a month with no lighting as 20 empty rank rows under the same uuids, and no summary', () => {
    const emptyEvents = buildCommunityEmptyMonthEvents({ month: '2026-09', complete: true });
    expect(emptyEvents).toHaveLength(20);
    expect(emptyEvents.every((monthEvent) => monthEvent.event === COMMUNITY_MONTHLY_RANK_EVENT)).toBe(true);
    for (const monthEvent of emptyEvents) {
      expect(monthEvent.properties).toMatchObject({ month: '2026-09', complete: true, empty: true });
      expect(monthEvent.properties.gymName ?? monthEvent.properties.climberName ?? null).toBeNull();
    }
    // The same uuids the month's rank rows were sent under, so they overwrite them.
    expect(emptyEvents.map((monthEvent) => monthEvent.uuid)).toEqual(
      buildCommunityMonthlyEvents(SEPTEMBER)
        .slice(1)
        .map((monthEvent) => monthEvent.uuid),
    );
  });

  it('never carries an id, an email, an avatar or a profile link, and only scalar values', () => {
    const forbidden = ['userid', 'user_id', 'email', 'distinct_id', 'avatar', 'image', 'profile', 'url', 'uuid'];
    for (const monthEvent of [
      ...buildCommunityMonthlyEvents(SEPTEMBER),
      ...buildCommunityEmptyMonthEvents({ month: '2026-10', complete: false }),
    ]) {
      for (const [key, value] of Object.entries(monthEvent.properties)) {
        for (const fragment of forbidden) expect(key.toLowerCase().includes(fragment), key).toBe(false);
        expect(key.toLowerCase()).not.toBe('id');
        expect(value === null || ['string', 'number', 'boolean'].includes(typeof value), key).toBe(true);
      }
    }
  });
});

describe('deterministicEventUuid', () => {
  it('keeps the active-users snapshot uuid it shipped with', () => {
    expect(deterministicEventUuid('boardsesh:active-users-snapshot:2026-10-08')).toBe(
      '3a051544-ac77-5665-9333-f8e22060254b',
    );
  });
});
