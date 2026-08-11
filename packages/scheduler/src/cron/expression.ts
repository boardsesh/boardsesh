/**
 * A deliberately small standard-cron parser.
 *
 * Scope is exactly what `packages/web/vercel.json` uses: five numeric fields
 * (`minute hour day-of-month month day-of-week`) with `*`, `a`, `a-b`, lists,
 * and `/step`. Month/weekday names, `@daily` shorthands, `L`/`W`/`#` and
 * seconds are NOT supported — they throw, so a schedule that silently means
 * something else can never reach production. `registry.test.ts` asserts every
 * registered schedule parses.
 */
export type CronFieldName = 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek';

export type CronExpression = {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** True when the day-of-month field is anything other than `*`. */
  readonly restrictsDayOfMonth: boolean;
  /** True when the day-of-week field is anything other than `*`. */
  readonly restrictsDayOfWeek: boolean;
};

/** Wall-clock fields of a single minute, already resolved into a timezone. */
export type CronTimeFields = {
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number;
  readonly month: number;
  /** 0 = Sunday. */
  readonly dayOfWeek: number;
};

export class CronExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronExpressionError';
  }
}

const FIELD_BOUNDS: Record<CronFieldName, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  // 7 is accepted as an alias for Sunday and normalised to 0.
  dayOfWeek: { min: 0, max: 7 },
};

function parseInteger(token: string, fieldName: CronFieldName, expression: string): number {
  if (!/^\d+$/.test(token)) {
    throw new CronExpressionError(
      `invalid ${fieldName} value ${JSON.stringify(token)} in cron ${JSON.stringify(expression)}`,
    );
  }
  return Number(token);
}

function parseField(rawField: string, fieldName: CronFieldName, expression: string): Set<number> {
  const { min, max } = FIELD_BOUNDS[fieldName];
  const values = new Set<number>();

  for (const listEntry of rawField.split(',')) {
    if (listEntry === '') {
      throw new CronExpressionError(`empty ${fieldName} entry in cron ${JSON.stringify(expression)}`);
    }

    const [rangePart, stepPart, ...extraParts] = listEntry.split('/');
    if (extraParts.length > 0) {
      throw new CronExpressionError(
        `invalid ${fieldName} step ${JSON.stringify(listEntry)} in cron ${JSON.stringify(expression)}`,
      );
    }

    let step = 1;
    if (stepPart !== undefined) {
      step = parseInteger(stepPart, fieldName, expression);
      if (step < 1) {
        throw new CronExpressionError(`${fieldName} step must be >= 1 in cron ${JSON.stringify(expression)}`);
      }
    }

    let rangeStart: number;
    let rangeEnd: number;

    if (rangePart === '*') {
      rangeStart = min;
      rangeEnd = max;
    } else if (rangePart.includes('-')) {
      const [startToken, endToken, ...extraRangeTokens] = rangePart.split('-');
      if (extraRangeTokens.length > 0) {
        throw new CronExpressionError(
          `invalid ${fieldName} range ${JSON.stringify(rangePart)} in cron ${JSON.stringify(expression)}`,
        );
      }
      rangeStart = parseInteger(startToken, fieldName, expression);
      rangeEnd = parseInteger(endToken, fieldName, expression);
      if (rangeEnd < rangeStart) {
        throw new CronExpressionError(
          `${fieldName} range ${JSON.stringify(rangePart)} is inverted in cron ${JSON.stringify(expression)}`,
        );
      }
    } else {
      rangeStart = parseInteger(rangePart, fieldName, expression);
      // `5/2` (a bare value with a step) means "from 5 to the field max".
      rangeEnd = stepPart === undefined ? rangeStart : max;
    }

    if (rangeStart < min || rangeEnd > max) {
      throw new CronExpressionError(
        `${fieldName} value out of range (${min}-${max}) in cron ${JSON.stringify(expression)}`,
      );
    }

    for (let value = rangeStart; value <= rangeEnd; value += step) {
      values.add(fieldName === 'dayOfWeek' && value === 7 ? 0 : value);
    }
  }

  return values;
}

export function parseCronExpression(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronExpressionError(
      `cron ${JSON.stringify(expression)} must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }

  const [rawMinute, rawHour, rawDayOfMonth, rawMonth, rawDayOfWeek] = fields;

  return {
    source: expression,
    minutes: parseField(rawMinute, 'minute', expression),
    hours: parseField(rawHour, 'hour', expression),
    daysOfMonth: parseField(rawDayOfMonth, 'dayOfMonth', expression),
    months: parseField(rawMonth, 'month', expression),
    daysOfWeek: parseField(rawDayOfWeek, 'dayOfWeek', expression),
    restrictsDayOfMonth: rawDayOfMonth !== '*',
    restrictsDayOfWeek: rawDayOfWeek !== '*',
  };
}

export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

export function matchesCronExpression(expression: CronExpression, time: CronTimeFields): boolean {
  if (!expression.minutes.has(time.minute)) return false;
  if (!expression.hours.has(time.hour)) return false;
  if (!expression.months.has(time.month)) return false;

  const dayOfMonthMatches = expression.daysOfMonth.has(time.dayOfMonth);
  const dayOfWeekMatches = expression.daysOfWeek.has(time.dayOfWeek);

  // Standard cron day semantics: when both day fields are restricted the day
  // matches if EITHER does; when only one is restricted, that one decides.
  if (expression.restrictsDayOfMonth && expression.restrictsDayOfWeek) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  if (expression.restrictsDayOfMonth) {
    return dayOfMonthMatches;
  }
  if (expression.restrictsDayOfWeek) {
    return dayOfWeekMatches;
  }
  return true;
}
