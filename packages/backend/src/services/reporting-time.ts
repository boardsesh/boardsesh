import { sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import type { TickReportingTimeInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';

const namedTimeZone = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z\d_+-]+)+)$/;
const instantShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/i;
const dayShape = /^\d{4}-\d{2}-\d{2}$/;
let postgresTimeZones: Promise<Map<string, string>> | undefined;
export type ReportingTimeZoneExecutor = Pick<typeof db, 'execute'>;

function getPostgresTimeZones(executor: ReportingTimeZoneExecutor): Promise<Map<string, string>> {
  postgresTimeZones ??= executor
    .execute(sql`SELECT name FROM pg_timezone_names`)
    .then((result) => {
      const rows = rowsFromResult<{ name: string }>(result);
      return new Map(rows.map(({ name }) => [name.toLowerCase(), name]));
    })
    .catch((error: unknown) => {
      postgresTimeZones = undefined;
      throw error;
    });
  return postgresTimeZones;
}

export async function validatedReportingTimeZone(
  timeZone: string,
  executor: ReportingTimeZoneExecutor = db,
): Promise<string | null> {
  if (!namedTimeZone.test(timeZone)) return null;
  try {
    const canonical = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
    const names = await getPostgresTimeZones(executor);
    return names.get(canonical.toLowerCase()) ?? names.get(timeZone.toLowerCase()) ?? null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

const unknownReportingTime = {
  reportingTimePrecision: null,
  reportingDate: null,
  reportingDateTimeZone: null,
};

type ReportingTime = {
  reportingTimePrecision: 'instant' | 'day' | null;
  reportingDate: string | null;
  reportingDateTimeZone: string | null;
};

export async function tickReportingTime(
  climbedAt: string,
  input?: TickReportingTimeInput | null,
): Promise<ReportingTime> {
  if (input?.precision === 'instant' && instantShape.test(climbedAt)) {
    return { ...unknownReportingTime, reportingTimePrecision: 'instant' };
  }
  if (input?.precision !== 'day' || !input.date || !dayShape.test(input.date) || !input.timeZone) {
    return unknownReportingTime;
  }
  const zone = await validatedReportingTimeZone(input.timeZone);
  if (!zone) return unknownReportingTime;
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(climbedAt));
  const getPart = (part: 'year' | 'month' | 'day') => parts.find(({ type }) => type === part)?.value;
  const originalCalendarDate = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
  if (input.date !== originalCalendarDate) return unknownReportingTime;
  return { reportingTimePrecision: 'day', reportingDate: input.date, reportingDateTimeZone: zone };
}
