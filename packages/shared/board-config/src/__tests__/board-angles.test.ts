import { describe, expect, it } from 'vitest';
import { ANGLES, getBoardAngleOptions, getRoutableBoardAngles, parseBoardAngleSegment } from '../board-data';

describe('board angles', () => {
  it('adds -5 only to the Grasshopper picker angles', () => {
    expect(ANGLES.grasshopper[0]).toBe(-5);
    expect(ANGLES.kilter[0]).toBe(0);
    expect(ANGLES.tension[0]).toBe(0);
    expect(ANGLES.moonboard).toEqual([25, 40]);
  });

  it('keeps every accepted integer URL routable independently of picker steps', () => {
    expect(getBoardAngleOptions('moonboard', false)).toEqual([25, 40]);
    expect(getRoutableBoardAngles('moonboard')).toContain(35);
    expect(getRoutableBoardAngles('moonboard')).toContain(41);
    expect(getRoutableBoardAngles('kilter')).toEqual(expect.arrayContaining([0, 41, 90]));
  });

  it('parses only exact canonical route segments supported by that board', () => {
    expect(parseBoardAngleSegment('grasshopper', '-5')).toBe(-5);
    expect(parseBoardAngleSegment('kilter', '-5')).toBeNull();
    expect(parseBoardAngleSegment('moonboard', '-5')).toBeNull();
    expect(parseBoardAngleSegment('moonboard', '35')).toBe(35);
    expect(parseBoardAngleSegment('kilter', '40')).toBe(40);
    expect(parseBoardAngleSegment('kilter', '41')).toBe(41);
    expect(parseBoardAngleSegment('kilter', '90')).toBe(90);

    for (const alias of ['040', '40.0', '+40', '4e1', ' 40', '40 ', '-0', '91', '999']) {
      expect(parseBoardAngleSegment('kilter', alias)).toBeNull();
    }
  });

  // #5488: the app shares a wall climb as `/b/{slug}/{angle}/view/...`, and www
  // runs the angle segment through this parser before it renders anything. Every
  // integer angle a wall can be set at has to route, not just the picker's
  // 5-degree steps, or a shared link 404s.
  it('routes every integer angle a spray wall can carry', () => {
    for (let angle = 0; angle <= 70; angle += 1) {
      expect(parseBoardAngleSegment('spray', String(angle))).toBe(angle);
    }
  });
});
