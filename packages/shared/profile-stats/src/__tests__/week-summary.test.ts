import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { buildWeekSummary, type WeekActivityEntry } from '../week-summary';

// Wednesday 18 November 2026, local time. The ISO week runs Mon 16 to Sun 22.
const TODAY = dayjs('2026-11-18T12:00:00');

type Entry = WeekActivityEntry & { id: string };

function tick(id: string, day: string, status: Entry['status'], difficulty: number | null = null): Entry {
  return { id, climbedAt: dayjs(`${day}T18:00:00`).toISOString(), status, difficulty, boardType: 'kilter' };
}

describe('buildWeekSummary', () => {
  it('reads an empty logbook as empty, with seven blank days', () => {
    const summary = buildWeekSummary([], { today: TODAY });
    expect(summary.isEmpty).toBe(true);
    expect(summary.isDormant).toBe(false);
    expect(summary.days.map((day) => day.date)).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ]);
    expect(summary.days.some((day) => day.active)).toBe(false);
    expect(summary.days.find((day) => day.isToday)?.date).toBe('2026-11-18');
    expect(summary.days.filter((day) => day.isFuture)).toHaveLength(4);
    expect(summary.weeksRunning).toBe(0);
    expect(summary.record).toBeNull();
  });

  it('counts days as sessions and flashes plus sends as sends; attempts make a day active', () => {
    const summary = buildWeekSummary(
      [
        tick('a', '2026-11-16', 'attempt', 20),
        tick('b', '2026-11-18', 'send', 18),
        tick('c', '2026-11-18', 'flash', 16),
        tick('d', '2026-11-18', 'attempt', 24),
        tick('old', '2026-11-12', 'send', 10),
      ],
      { today: TODAY },
    );
    expect(summary.sessions).toBe(2);
    expect(summary.sends).toBe(2);
    expect(summary.days.filter((day) => day.active).map((day) => day.date)).toEqual(['2026-11-16', '2026-11-18']);
    expect(summary.hardestSend?.id).toBe('b');
  });

  it('keeps the latest of two equally hard sends', () => {
    const summary = buildWeekSummary(
      [tick('early', '2026-11-16', 'send', 18), tick('late', '2026-11-17', 'send', 18)],
      {
        today: TODAY,
      },
    );
    expect(summary.hardestSend?.id).toBe('late');
  });

  it('counts weeks in a row, and a week still under way does not break the run', () => {
    const run = [
      tick('w1', '2026-10-27', 'send'),
      tick('w2', '2026-11-03', 'attempt'),
      tick('w3', '2026-11-10', 'send'),
    ];
    expect(buildWeekSummary(run, { today: TODAY }).weeksRunning).toBe(3);
    expect(buildWeekSummary([...run, tick('now', '2026-11-16', 'send')], { today: TODAY }).weeksRunning).toBe(4);
  });

  it('ends the run after one empty week', () => {
    const summary = buildWeekSummary([tick('w1', '2026-10-27', 'send'), tick('w3', '2026-11-10', 'send')], {
      today: TODAY,
    });
    expect(summary.weeksRunning).toBe(1);
    const lapsed = buildWeekSummary([tick('w1', '2026-10-27', 'send'), tick('w2', '2026-11-03', 'send')], {
      today: TODAY,
    });
    expect(lapsed.weeksRunning).toBe(0);
  });

  it('marks a new top grade as a first', () => {
    const summary = buildWeekSummary([tick('old', '2026-11-02', 'send', 20), tick('new', '2026-11-17', 'send', 22)], {
      today: TODAY,
    });
    expect(summary.record).toEqual({ kind: 'firstGrade', entry: expect.objectContaining({ id: 'new' }) });
  });

  it('is not a first when the harder send reads as the same grade', () => {
    const vGrade = (difficulty: number) => (difficulty >= 21 ? 'V6' : 'V5');
    const summary = buildWeekSummary([tick('old', '2026-11-02', 'send', 21), tick('new', '2026-11-17', 'send', 22)], {
      today: TODAY,
      gradeLabel: vGrade,
    });
    expect(summary.record).toBeNull();
  });

  it('counts a first graded send ever as a first', () => {
    const summary = buildWeekSummary([tick('first', '2026-11-17', 'send', 16)], { today: TODAY });
    expect(summary.record?.kind).toBe('firstGrade');
  });

  it('falls back to the hardest flash when no new top grade was sent', () => {
    const summary = buildWeekSummary(
      [
        tick('top', '2026-11-02', 'send', 24),
        tick('oldFlash', '2026-11-03', 'flash', 18),
        tick('newFlash', '2026-11-17', 'flash', 20),
      ],
      { today: TODAY },
    );
    expect(summary.record).toEqual({ kind: 'hardestFlash', entry: expect.objectContaining({ id: 'newFlash' }) });
  });

  it('does not call a first-ever flash a record', () => {
    const summary = buildWeekSummary(
      [tick('top', '2026-11-02', 'send', 24), tick('flash', '2026-11-17', 'flash', 20)],
      {
        today: TODAY,
      },
    );
    expect(summary.record).toBeNull();
  });

  it('ignores ungraded sends for records and the hardest send', () => {
    const summary = buildWeekSummary([tick('ungraded', '2026-11-17', 'send', null)], { today: TODAY });
    expect(summary.sends).toBe(1);
    expect(summary.hardestSend).toBeNull();
    expect(summary.record).toBeNull();
  });

  it('counts a tick dated after today as today', () => {
    const summary = buildWeekSummary([tick('ahead', '2026-11-25', 'send', 20)], { today: TODAY });
    expect(summary.sessions).toBe(1);
    expect(summary.sends).toBe(1);
    expect(summary.days.find((day) => day.isToday)?.active).toBe(true);
  });

  it('is dormant after 28 days with nothing logged', () => {
    expect(buildWeekSummary([tick('old', '2026-10-22', 'send')], { today: TODAY }).isDormant).toBe(false);
    expect(buildWeekSummary([tick('old', '2026-10-21', 'send')], { today: TODAY }).isDormant).toBe(true);
  });
});
