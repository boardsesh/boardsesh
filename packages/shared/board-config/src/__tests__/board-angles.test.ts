// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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
});
