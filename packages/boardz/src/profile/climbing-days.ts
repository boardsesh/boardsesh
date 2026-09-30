import type { LogbookEntry } from '@boardsesh/profile-stats';
import { tickTimeMs } from '@boardsesh/profile-stats';

export type ClimbingDay = {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  sends: number;
  flashes: number;
  /** Every try logged that day, sends included. */
  tries: number;
  hardestSendDifficulty: number | null;
};

function localDate(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The climber's days on the board, most recent first. */
export function climbingDays(entries: readonly LogbookEntry[]): ClimbingDay[] {
  const days = new Map<string, ClimbingDay>();
  for (const entry of entries) {
    const ms = tickTimeMs(entry.climbed_at);
    if (!Number.isFinite(ms)) continue;
    const date = localDate(ms);
    const day = days.get(date) ?? { date, sends: 0, flashes: 0, tries: 0, hardestSendDifficulty: null };
    day.tries += entry.tries;
    if (entry.status === 'send' || entry.status === 'flash') {
      day.sends += 1;
      if (entry.status === 'flash') day.flashes += 1;
      const grade = entry.effectiveDifficulty ?? entry.difficulty;
      if (grade != null && (day.hardestSendDifficulty === null || grade > day.hardestSendDifficulty)) {
        day.hardestSendDifficulty = grade;
      }
    }
    days.set(date, day);
  }
  return [...days.values()].sort((first, second) => second.date.localeCompare(first.date));
}

const WEEKDAY_MONTH = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** "Today", "Yesterday", or "Mon 22 Sep" for a YYYY-MM-DD date. */
export function dayLabel(date: string, today: Date): string {
  const todayKey = localDate(today.getTime());
  const yesterdayKey = localDate(today.getTime() - 24 * 60 * 60 * 1000);
  if (date === todayKey) return 'Today';
  if (date === yesterdayKey) return 'Yesterday';
  const [year, month, day] = date.split('-').map(Number);
  return WEEKDAY_MONTH.format(new Date(year, month - 1, day));
}
