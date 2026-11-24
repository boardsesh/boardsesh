import type { GymClimbRankingMode, GymClimbRankingRow } from '@boardsesh/shared-schema';
import { formatGymReportingDate, formatGymReportingTime } from './gym-reporting';

export const GYM_CLIMB_RANKINGS_QUERY_SEGMENT = 'climb-rankings';

export const GYM_CLIMB_RANKING_MODES = [
  'MOST_SENT',
  'TOP_RATED',
  'MOST_DISCUSSED',
  'GRADE_FEEDBACK',
  'QUIET_CLIMBS',
] as const satisfies readonly GymClimbRankingMode[];

export const GYM_CLIMB_RANKING_MODE_COPY = {
  MOST_SENT: { label: 'mostSent', method: 'mostSentMethod' },
  TOP_RATED: { label: 'topRated', method: 'topRatedMethod' },
  MOST_DISCUSSED: { label: 'mostDiscussed', method: 'mostDiscussedMethod' },
  GRADE_FEEDBACK: { label: 'gradeFeedback', method: 'gradeFeedbackMethod' },
  QUIET_CLIMBS: { label: 'quietClimbs', method: 'quietMethod' },
} as const;

type Metric =
  | { key: 'sends'; values: { sendCount: string; senderCount: string } }
  | { key: 'rating'; values: { stars: string; votes: string } }
  | { key: 'comments'; values: { commentCount: string; authorCount: string } }
  | { key: 'harder' | 'easier'; values: { steps: string; votes: string } }
  | { key: 'sameGrade'; values: { votes: string } }
  | { key: 'quietRate'; values: { rate: string; sends: string } }
  | { key: 'quietExposure'; values: { lifetime: string; window: string } }
  | { key: 'firstAvailable' | 'lastSendTime' | 'lastSendDay'; values: { date: string } }
  | { key: 'lastSendRange'; values: { start: string; end: string } }
  | { key: 'noMeasuredSend'; values?: undefined };

export function gymClimbRankingRowKey({ physicalBoardUuid, target }: GymClimbRankingRow) {
  return JSON.stringify([physicalBoardUuid, target.boardType, target.climbUuid, target.angle, target.isMirror]);
}

export function createGymClimbRankingFormat(
  locale: string,
  timeZone: string,
  formatGrade: (difficulty: number | null, boardType: string) => string | null,
) {
  const integer = new Intl.NumberFormat(locale);
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const rate = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  const date = (instant: string) => formatGymReportingDate(instant, timeZone, locale);

  function metricsFor(row: GymClimbRankingRow, mode: GymClimbRankingMode): Metric[] {
    switch (mode) {
      case 'MOST_SENT':
        return row.sendCount !== null && row.senderCount !== null
          ? [
              {
                key: 'sends',
                values: { sendCount: integer.format(row.sendCount), senderCount: integer.format(row.senderCount) },
              },
            ]
          : [];
      case 'TOP_RATED':
        return row.qualityMean !== null && row.voterCount !== null
          ? [
              {
                key: 'rating',
                values: { stars: decimal.format(row.qualityMean), votes: integer.format(row.voterCount) },
              },
            ]
          : [];
      case 'MOST_DISCUSSED':
        return row.commentCount !== null && row.authorCount !== null
          ? [
              {
                key: 'comments',
                values: {
                  commentCount: integer.format(row.commentCount),
                  authorCount: integer.format(row.authorCount),
                },
              },
            ]
          : [];
      case 'GRADE_FEEDBACK': {
        if (row.gradeDelta === null || row.voterCount === null) return [];
        const votes = integer.format(row.voterCount);
        return row.gradeDelta === 0
          ? [{ key: 'sameGrade', values: { votes } }]
          : [
              {
                key: row.gradeDelta > 0 ? 'harder' : 'easier',
                values: { steps: decimal.format(Math.abs(row.gradeDelta)), votes },
              },
            ];
      }
      case 'QUIET_CLIMBS': {
        const metrics: Metric[] = [];
        if (row.sendsPerDay !== null && row.sendCount !== null) {
          metrics.push({
            key: 'quietRate',
            values: { rate: rate.format(row.sendsPerDay), sends: integer.format(row.sendCount) },
          });
        }
        if (row.knownLifetimeDays !== null && row.knownWindowDays !== null) {
          metrics.push({
            key: 'quietExposure',
            values: { lifetime: decimal.format(row.knownLifetimeDays), window: decimal.format(row.knownWindowDays) },
          });
        }
        if (row.firstKnownAvailableAt) {
          metrics.push({ key: 'firstAvailable', values: { date: date(row.firstKnownAvailableAt) } });
        }
        if (row.lastSendDate) {
          // The backend already certified a local calendar date. Format the
          // calendar value in UTC so the viewer's zone cannot move it a day.
          metrics.push({
            key: 'lastSendDay',
            values: { date: formatGymReportingDate(row.lastSendDate, 'UTC', locale) },
          });
        } else if (row.lastSendAt && row.lastSendEndAt) {
          metrics.push({
            key: 'lastSendRange',
            values: {
              start: date(row.lastSendAt),
              end: date(new Date(Date.parse(row.lastSendEndAt) - 1).toISOString()),
            },
          });
        } else if (row.lastSendAt) {
          metrics.push({
            key: 'lastSendTime',
            values: { date: formatGymReportingTime(row.lastSendAt, timeZone, locale) },
          });
        } else {
          metrics.push({ key: 'noMeasuredSend' });
        }
        return metrics;
      }
    }
  }

  return (row: GymClimbRankingRow, mode: GymClimbRankingMode) => ({
    rank: integer.format(row.rank),
    name: row.target.name,
    board: row.boardName,
    angle: integer.format(row.target.angle),
    mirrored: row.target.isMirror,
    grade: formatGrade(row.target.referenceDifficulty, row.target.boardType),
    metrics: metricsFor(row, mode),
  });
}

export const GYM_CLIMB_RANKING_STATUS_COPY = {
  LOADING: 'loading',
  OFFLINE: 'offline',
  DENIED: 'denied',
  SCOPE_TOO_LARGE: 'scopeTooLarge',
  TEMPORARILY_UNAVAILABLE: 'unavailable',
  EXPOSURE_UNAVAILABLE: 'exposureUnavailable',
  PAGE_CHANGED: 'pageChanged',
} as const;
