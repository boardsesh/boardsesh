import type { GymAngleActivityCounts, GymStats } from '@boardsesh/shared-schema';

type Summary = 'empty' | 'unknownOnly' | 'unidentified' | 'single' | 'tied' | 'mostUsed';

function angleUsageSummary(rowCount: number, leaderCount: number, hasUnknown: boolean): Summary {
  if (rowCount === 0) return hasUnknown ? 'unknownOnly' : 'empty';
  if (leaderCount === 0) return 'unidentified';
  if (rowCount === 1) return 'single';
  return leaderCount > 1 ? 'tied' : 'mostUsed';
}

export function presentGymAngleUsage(stats: Pick<GymStats, 'angleUsage' | 'boards'>, locale: string) {
  const number = new Intl.NumberFormat(locale);
  const percentage = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 });
  const minimumPercentage = 0.0001;
  const boardNames = new Map(stats.boards.map(({ uuid, name }) => [uuid, name]));
  const activityCounts = ({ tickCount, sendCount, displayCount }: GymAngleActivityCounts) => ({
    ticks: number.format(tickCount),
    sends: number.format(sendCount),
    displays: number.format(displayCount),
  });

  return stats.angleUsage.flatMap((report) => {
    const boardName = boardNames.get(report.boardUuid);
    if (boardName === undefined) return [];

    const maxClimbers = report.angles.reduce((max, angle) => Math.max(max, angle.distinctClimberCount), 0);
    const rows = [...report.angles]
      .sort((left, right) => left.angle - right.angle)
      .map((angle) => {
        const share =
          report.knownAngleClimberCount > 0 ? angle.distinctClimberCount / report.knownAngleClimberCount : null;
        const isBelowMinimum = share !== null && share > 0 && share < minimumPercentage;
        return {
          angle: angle.angle,
          angleLabel: `${number.format(angle.angle)}°`,
          climbers: number.format(angle.distinctClimberCount),
          climberDays: number.format(angle.climberDayCount),
          unresolvedDates:
            angle.unresolvedLocalDateTickCount > 0 ? number.format(angle.unresolvedLocalDateTickCount) : null,
          isLeader: maxClimbers > 0 && angle.distinctClimberCount === maxClimbers,
          share,
          percentLabel: share === null ? null : percentage.format(isBelowMinimum ? minimumPercentage : share),
          isBelowMinimum,
          ...activityCounts(angle),
        };
      });

    const unknown =
      report.unknownAngle.tickCount + report.unknownAngle.displayCount > 0 ? activityCounts(report.unknownAngle) : null;
    const leaders = rows.filter(({ isLeader }) => isLeader);
    return [
      {
        boardUuid: report.boardUuid,
        boardName,
        sample: number.format(report.knownAngleClimberCount),
        rows,
        unknown,
        leaders: leaders.map(({ angleLabel }) => angleLabel).join(locale.startsWith('zh') ? '、' : ', '),
        summary: angleUsageSummary(rows.length, leaders.length, unknown !== null),
        leadingClimbers: number.format(maxClimbers),
      },
    ];
  });
}

export type GymAngleUsageBoardPresentation = ReturnType<typeof presentGymAngleUsage>[number];
export type GymAngleUsageRowPresentation = GymAngleUsageBoardPresentation['rows'][number];
