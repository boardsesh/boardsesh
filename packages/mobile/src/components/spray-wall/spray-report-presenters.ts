import type { SprayWallReportData, SprayWallReportReason } from '@boardsesh/graphql/operations/spray-walls';

export type SprayWallReportGroup = {
  wallUuid: string;
  wallName: string;
  hidden: boolean;
  photo: SprayWallReportData['photo'];
  reasons: SprayWallReportReason[];
  reportCount: number;
};

export function groupSprayWallReports(reports: readonly SprayWallReportData[]): SprayWallReportGroup[] {
  const grouped = new Map<string, SprayWallReportGroup>();
  for (const report of reports) {
    const group = grouped.get(report.wallUuid);
    if (group) {
      group.reportCount += 1;
      if (!group.reasons.includes(report.reason)) group.reasons.push(report.reason);
    } else {
      grouped.set(report.wallUuid, {
        wallUuid: report.wallUuid,
        wallName: report.wallName,
        hidden: report.hidden,
        photo: report.photo,
        reasons: [report.reason],
        reportCount: 1,
      });
    }
  }
  return [...grouped.values()];
}
