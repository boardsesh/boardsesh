import type { SprayWallReportData, SprayWallReportReason } from '@boardsesh/graphql/operations/spray-walls';

export type SprayWallReportGroup = {
  wallUuid: string;
  wallName: string;
  hidden: boolean;
  photo: SprayWallReportData['photo'];
  reasons: SprayWallReportReason[];
  reportCount: number;
  reportReleaseContexts: Array<{
    reportId: string;
    releaseContext: NonNullable<SprayWallReportData['releaseContext']>;
  }>;
};

export function groupSprayWallReports(reports: readonly SprayWallReportData[]): SprayWallReportGroup[] {
  const grouped = new Map<string, SprayWallReportGroup>();
  const releaseContextsByWall = new Map<string, Map<string, SprayWallReportGroup['reportReleaseContexts'][number]>>();
  for (const report of reports) {
    if (report.releaseContext) {
      const { channel, branch, updateId, runtimeVersion, isEmbeddedLaunch, automaticCanary } = report.releaseContext;
      const identity = JSON.stringify([channel, branch, updateId, runtimeVersion, isEmbeddedLaunch, automaticCanary]);
      const contexts = releaseContextsByWall.get(report.wallUuid) ?? new Map();
      if (!contexts.has(identity))
        contexts.set(identity, { reportId: report.id, releaseContext: report.releaseContext });
      releaseContextsByWall.set(report.wallUuid, contexts);
    }
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
        reportReleaseContexts: [],
      });
    }
  }
  return [...grouped.values()].map((group) => ({
    ...group,
    reportReleaseContexts: [...(releaseContextsByWall.get(group.wallUuid)?.values() ?? [])],
  }));
}
