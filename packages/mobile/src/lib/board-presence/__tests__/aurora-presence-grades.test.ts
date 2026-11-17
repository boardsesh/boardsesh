import { describe, expect, it } from 'vitest';
import { parse } from 'graphql';
import { BOARD_PRESENCE_CLIMB_GRADES } from '@boardsesh/graphql/operations/board-presence';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { auroraPresenceGradeUuids } from '../aurora-presence-grades';

function occurrence(uuid: string, source: BoardPresenceClimb['source'] = 'aurora'): BoardPresenceClimb {
  return { source, climbUuid: uuid, angle: null, seq: 1, sentAt: '2026-11-17T00:00:00Z' };
}

describe('Aurora wall grade batch', () => {
  it('only reads visible Aurora catalog entries and deduplicates repeat occurrences', () => {
    expect(
      auroraPresenceGradeUuids([
        occurrence('b'),
        occurrence('a'),
        occurrence('a'),
        occurrence('native', 'boardsesh'),
        occurrence('kilter', 'kilter'),
      ]),
    ).toEqual(['a', 'b']);
    expect(auroraPresenceGradeUuids(Array.from({ length: 100 }, (_, index) => occurrence(String(index))))).toHaveLength(
      50,
    );
  });

  it('uses one set-based, wall-gated catalog operation at the selected angle', () => {
    expect(() => parse(BOARD_PRESENCE_CLIMB_GRADES)).not.toThrow();
    expect(BOARD_PRESENCE_CLIMB_GRADES).toContain('boardPresenceClimbGrades(');
    expect(BOARD_PRESENCE_CLIMB_GRADES).toContain('boardId: $boardId');
    expect(BOARD_PRESENCE_CLIMB_GRADES).toContain('boardUuid: $boardUuid');
    expect(BOARD_PRESENCE_CLIMB_GRADES).toContain('angle: $angle');
    expect(BOARD_PRESENCE_CLIMB_GRADES).toContain('climbUuids: $climbUuids');
    expect(BOARD_PRESENCE_CLIMB_GRADES).not.toContain('climb0:');
  });
});
