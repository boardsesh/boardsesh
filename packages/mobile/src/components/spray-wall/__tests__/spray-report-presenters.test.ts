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
