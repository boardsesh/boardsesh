import { describe, expect, it } from 'vite-plus/test';
import type { GymAngleUsageRow, GymBoardAngleUsage, GymReportingBoard } from '@boardsesh/shared-schema';
import { presentGymAngleUsage } from '../gym-angle-usage';

const emptyCounts = { tickCount: 0, sendCount: 0, displayCount: 0 };
const board: GymReportingBoard = { uuid: 'wall', name: 'Wall', boardType: 'grasshopper', configurations: [] };
const angle = (degrees: number, distinctClimberCount: number): GymAngleUsageRow => ({
  angle: degrees,
  distinctClimberCount,
  climberDayCount: distinctClimberCount,
  unresolvedLocalDateTickCount: 0,
  ...emptyCounts,
});

function present(report: Partial<GymBoardAngleUsage>, locale = 'en-US') {
  return presentGymAngleUsage(
    {
      boards: [board],
      angleUsage: [
        { boardUuid: board.uuid, angles: [], knownAngleClimberCount: 0, unknownAngle: emptyCounts, ...report },
      ],
    },
    locale,
  );
}

describe('gym angle usage presentation', () => {
  it('orders recorded degrees, highlights all positive leaders and uses an overlapping physical sample', () => {
    const [report] = present({
      angles: [angle(45, 2), angle(-5, 2), angle(0, 1)],
      knownAngleClimberCount: 3,
    });
    expect(report.sample).toBe('3');
    expect(report.summary).toBe('tied');
    expect(report.leaders).toBe('-5°, 45°');
    expect(report.rows.map(({ angle, isLeader, percentLabel }) => [angle, isLeader, percentLabel])).toEqual([
      [-5, true, '66.67%'],
      [0, false, '33.33%'],
      [45, true, '66.67%'],
    ]);
  });

  it('distinguishes zero activity, unknown angles, unidentified records and a single observed angle', () => {
    expect(present({})[0].summary).toBe('empty');
    expect(present({ unknownAngle: { ...emptyCounts, displayCount: 1 } })[0].summary).toBe('unknownOnly');
    const [anonymous] = present({ angles: [{ ...angle(40, 0), displayCount: 1 }] });
    expect(anonymous.summary).toBe('unidentified');
    expect(anonymous.rows[0]).toMatchObject({ isLeader: false, percentLabel: null });
    const [single] = present({ angles: [angle(41, 1)], knownAngleClimberCount: 1 });
    expect(single.summary).toBe('single');
    expect(single.rows[0]).toMatchObject({ isLeader: true, percentLabel: '100%' });
    expect(present({ angles: [angle(40, 1), angle(45, 2)], knownAngleClimberCount: 2 })[0].summary).toBe('mostUsed');
  });

  it('formats tiny positive percentages and omits an angle group without a reporting board', () => {
    const [report] = present({ angles: [angle(40, 1)], knownAngleClimberCount: 20_000 });
    expect(report.rows[0]).toMatchObject({ isBelowMinimum: true, percentLabel: '0.01%' });
    expect(present({ boardUuid: 'missing' })).toEqual([]);
  });
});
