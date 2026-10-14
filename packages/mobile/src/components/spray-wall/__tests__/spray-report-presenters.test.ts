import { describe, expect, it } from 'vitest';
import type { SprayWallReportData } from '@boardsesh/graphql/operations/spray-walls';
import { groupSprayWallReports } from '../spray-report-presenters';

const report = (overrides: Partial<SprayWallReportData> = {}): SprayWallReportData => ({
  id: 'report-1',
  wallUuid: 'wall-a',
  wallName: 'Crew wall',
  layoutId: 1,
  reason: 'INAPPROPRIATE',
  hidden: false,
  createdAt: '2026-10-01',
  photo: null,
  ...overrides,
});
describe('groupSprayWallReports', () => {
  it('keeps distinct releases and collapses repeats for the same wall', () => {
    const releaseContext = {
      channel: 'production',
      branch: 'production',
      updateId: 'update-a',
      runtimeVersion: 'fingerprint',
      isEmbeddedLaunch: false,
      automaticCanary: true,
      canaryCheckedAt: '2026-10-14T09:00:00Z',
    };
    const [group] = groupSprayWallReports([
      report({ releaseContext }),
      report({ id: '2', releaseContext: { ...releaseContext, canaryCheckedAt: '2026-10-14T08:00:00Z' } }),
      report({ id: '3', releaseContext: { ...releaseContext, branch: 'pr-beta', automaticCanary: false } }),
      report({ id: '4', releaseContext: null }),
    ]);
    expect(group.reportCount).toBe(4);
    expect(group.reportReleaseContexts).toHaveLength(2);
    expect(group.reportReleaseContexts[0].releaseContext).toEqual(releaseContext);
    expect(group.reportReleaseContexts[1].releaseContext.branch).toBe('pr-beta');
  });

  it('groups reports by wall while counting repeated reasons once in the display', () => {
    const grouped = groupSprayWallReports([
      report(),
      report({ id: '2', reason: 'PERSONAL_INFO' }),
      report({ id: '3' }),
      report({ id: '4', wallUuid: 'wall-b', wallName: 'Other wall', hidden: true }),
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({
      wallUuid: 'wall-a',
      reportCount: 3,
      reasons: ['INAPPROPRIATE', 'PERSONAL_INFO'],
    });
    expect(grouped[1]).toMatchObject({ wallUuid: 'wall-b', hidden: true, photo: null });
  });
  it('does not change the report source', () => {
    const reports = [Object.freeze(report())];
    groupSprayWallReports(reports);
    expect(reports[0]).not.toHaveProperty('reportCount');
    expect(groupSprayWallReports([])).toEqual([]);
  });
});
