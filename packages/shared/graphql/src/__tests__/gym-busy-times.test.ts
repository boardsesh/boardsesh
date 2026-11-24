import { describe, expect, it } from 'vite-plus/test';
import type { GymBusyTimes } from '@boardsesh/shared-schema';
import { gymBusyTimesModel, nextGymBusyHour } from '../gym-busy-times';

const t = (key: string, values?: Record<string, string>) => [key, ...Object.values(values ?? {})].join(' ');
const weekdays = Array.from({ length: 7 }, (_, index) => ({
  dayOfWeek: index + 1,
  eligibleDates: index === 2 ? 0 : 12,
  recordedClimbers: 0,
}));
const hours = weekdays.flatMap((day) => Array.from({ length: 24 }, (_, hour) => ({ ...day, hour })));
const empty: GymBusyTimes = {
  status: 'ready',
  startDate: '2024-10-01',
  endDate: '2024-12-29',
  coveredDates: 72,
  firstCoveredDate: '2024-10-01',
  instantDisplays: 0,
  instantTicks: 0,
  dateOnlyRecords: 0,
  unplacedDateOnlyRecords: 0,
  unknownTimeRecords: 0,
  hasUnboundedUnknownTime: false,
  weekdays,
  hours,
};

describe('busy times display', () => {
  it('uses displayed rounded values and stable weekday/hour ties', () => {
    const model = gymBusyTimesModel(
      {
        ...empty,
        instantTicks: 2,
        weekdays: weekdays.map((entry, index) =>
          index < 2 ? { ...entry, recordedClimbers: 14, eligibleDates: index === 0 ? 13 : 12 } : entry,
        ),
        hours: hours.map((entry, index) => ([0, 1, 24].includes(index) ? { ...entry, recordedClimbers: 14 } : entry)),
      },
      'America/New_York',
      'en-US',
      t,
    );
    expect(model.dailyCells.slice(0, 2).map((entry) => entry.averageText)).toEqual(['1.1', '1.2']);
    expect(model.dailySummary).toBe('gymBusyTimes.dailySummary Tuesday 1.2');
    expect(model.hourlySummary).toBe(
      'gymBusyTimes.hourlySummary gymBusyTimes.dayHour Monday gymBusyTimes.hourSpan 12:00 AM 1:00 AM 1.2',
    );
    const displayedTie = gymBusyTimesModel(
      {
        ...empty,
        weekdays: weekdays.map((entry, index) =>
          index === 0
            ? { ...entry, recordedClimbers: 14, eligibleDates: 13 }
            : index === 1
              ? { ...entry, recordedClimbers: 13 }
              : entry,
        ),
      },
      'America/New_York',
      'en-US',
      t,
    );
    expect(displayedTie.dailyCells.slice(0, 2).map((entry) => entry.averageText)).toEqual(['1.1', '1.1']);
    expect(displayedTie.dailySummary).toBe('gymBusyTimes.dailySummary Monday 1.1');
  });

  it('distinguishes exact zero, missing and insufficient timing evidence', () => {
    const model = gymBusyTimesModel(empty, 'Pacific/Auckland', 'en-US', t);
    expect(model.dailyCells[0]).toMatchObject({ state: 'zero', dateCount: '12', recordedCount: '0' });
    expect(model.dailyCells[2]).toMatchObject({ state: 'missing', dateCount: '0' });
    expect(model.hourlyRows[2].hours[20].intensity).toBe(0);
    expect(model.dailySummary).toBe('');
    expect(model.hourlySummary).toBe('');
    expect(model.ranges).toContain('Oct 1, 2024');
    const dayOnly = gymBusyTimesModel(
      {
        ...empty,
        dateOnlyRecords: 1,
        weekdays: weekdays.map((entry, index) => (index === 0 ? { ...entry, recordedClimbers: 1 } : entry)),
      },
      'Pacific/Auckland',
      'en-US',
      t,
    );
    expect(dayOnly.dailySummary).toContain('Monday');
    expect(dayOnly.hourlyRows[0].hours[0]).toMatchObject({ state: 'insufficient', dateCount: '12' });
    expect(dayOnly.hourlySummary).toBe('');
    expect(dayOnly.hourlyNotice).toBe('gymBusyTimes.hourlyInsufficient');

    const mixed = gymBusyTimesModel({ ...empty, instantTicks: 1, unknownTimeRecords: 1 }, 'UTC', 'en-US', t);
    expect(mixed.hourlyRows[0].hours[0]).toMatchObject({ state: 'zero', limited: 'gymBusyTimes.timingLimited' });

    const oldUnknown = gymBusyTimesModel({ ...empty, hasUnboundedUnknownTime: true }, 'UTC', 'en-US', t);
    expect(oldUnknown.dailyCells[0].state).toBe('insufficient');
    expect(oldUnknown.hourlyRows[0].hours[0].state).toBe('insufficient');
    expect(oldUnknown.dailySummary).toBe('');
    expect(oldUnknown.hourlySummary).toBe('');
  });

  it('keeps grid navigation within the seven days and 24 hours', () => {
    expect(nextGymBusyHour(0, 'ArrowDown')).toBe(24);
    expect(nextGymBusyHour(24, 'ArrowRight')).toBe(25);
    expect(nextGymBusyHour(24, 'ArrowLeft')).toBe(24);
    expect(nextGymBusyHour(167, 'ArrowDown')).toBe(167);
    expect(nextGymBusyHour(24, 'End')).toBe(47);
    expect(nextGymBusyHour(37, 'Home')).toBe(24);
    expect(nextGymBusyHour(37, 'Tab')).toBeNull();
  });
});
