import { parseTickTime } from './format-tick-time';
import type { LogbookEntry } from './types';

/**
 * Lifetime story of ONE climb, split per angle: total tries, distinct sessions
 * (a session = a distinct local calendar day, the same day-scoped convention
 * the logbook's repeat grouping uses), and sends. This is where "sent in 13
 * tries over 3 sessions" lives — the logbook list shows per-day truth, the
 * climb's own view shows the journey (PR #3350 thread).
 * Returned ASCENDING by angle (a stable stats order for charts/tables);
 * groupEntriesByAngle re-orders its SECTIONS steepest-first for display.
 */
export type AngleLifetimeStats = {
  angle: number;
  totalTries: number;
  sessionCount: number;
  sendCount: number;
};

/**
 * The climb's entries bucketed under per-angle section headers, each section
 * carrying its lifetime recap. Sections are ordered steepest angle first (the
 * hardest version of the climb leads); entries keep their relative order
 * (callers pass newest-first) within a section.
 */
export type AngleEntriesSection<T extends LogbookEntry> = {
  angle: number;
  stats: AngleLifetimeStats;
  entries: T[];
};

export function groupEntriesByAngle<T extends LogbookEntry>(entries: readonly T[]): AngleEntriesSection<T>[] {
  const statsByAngle = new Map(deriveAngleLifetimeStats(entries).map((stats) => [stats.angle, stats]));
  const sectionByAngle = new Map<number, AngleEntriesSection<T>>();
  for (const entry of entries) {
    let section = sectionByAngle.get(entry.angle);
    if (!section) {
      const stats = statsByAngle.get(entry.angle);
      if (!stats) continue;
      section = { angle: entry.angle, stats, entries: [] };
      sectionByAngle.set(entry.angle, section);
    }
    section.entries.push(entry);
  }
  return Array.from(sectionByAngle.values()).sort((sectionA, sectionB) => sectionB.angle - sectionA.angle);
}

export function deriveAngleLifetimeStats(entries: readonly LogbookEntry[]): AngleLifetimeStats[] {
  const byAngle = new Map<number, { totalTries: number; days: Set<string>; sendCount: number }>();
  for (const entry of entries) {
    let stats = byAngle.get(entry.angle);
    if (!stats) {
      stats = { totalTries: 0, days: new Set<string>(), sendCount: 0 };
      byAngle.set(entry.angle, stats);
    }
    // Floor imported zero-try ticks at 1, matching how a single row displays.
    stats.totalTries += Math.max(1, entry.tries);
    stats.days.add(parseTickTime(entry.climbed_at).format('YYYY-MM-DD'));
    if (entry.status === 'flash' || entry.status === 'send') stats.sendCount += 1;
  }
  return Array.from(byAngle.entries())
    .map(([angle, stats]) => ({
      angle,
      totalTries: stats.totalTries,
      sessionCount: stats.days.size,
      sendCount: stats.sendCount,
    }))
    .sort((a, b) => a.angle - b.angle);
}
