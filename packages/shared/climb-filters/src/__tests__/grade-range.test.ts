import { describe, it, expect } from 'vitest';
import {
  RANGE_EXTEND_WINDOW_MS,
  isAnyGrade,
  clearGradeBound,
  isSameGradeBound,
  findGradeStop,
  isGradeStopEnd,
  isGradeStopAlone,
  isGradeStopInRange,
  findSelectedGradeStop,
  computeGradeTap,
  extendGradeRange,
  type GradeBound,
  type GradeStop,
} from '../grade-range';

// A picker row under V grades. V0 and V1 are grouped stops (several grade ids
// read the same), the rest are one grade each. Id 25 has no stop at all: a
// bound can hold it when it was saved on another board's scale.
const V0: GradeStop = { minGradeId: 10, maxGradeId: 12 };
const V1: GradeStop = { minGradeId: 13, maxGradeId: 14 };
const V2: GradeStop = { minGradeId: 15, maxGradeId: 15 };
const V3: GradeStop = { minGradeId: 16, maxGradeId: 16 };
const V4: GradeStop = { minGradeId: 17, maxGradeId: 17 };
const V5: GradeStop = { minGradeId: 18, maxGradeId: 18 };
const V6: GradeStop = { minGradeId: 19, maxGradeId: 19 };
const stops: GradeStop[] = [V0, V1, V2, V3, V4, V5, V6];

const any: GradeBound = { minGradeId: undefined, maxGradeId: undefined };
const onlyV3: GradeBound = { minGradeId: 16, maxGradeId: 16 };
const onlyV0: GradeBound = { minGradeId: 10, maxGradeId: 12 };
const v2ToV5: GradeBound = { minGradeId: 15, maxGradeId: 18 };
// Older data, or a bound made under Font grades: it starts and ends inside V0.
const insideV0: GradeBound = { minGradeId: 11, maxGradeId: 11 };
const fromV4Up: GradeBound = { minGradeId: 17, maxGradeId: undefined };
const upToV4: GradeBound = { minGradeId: undefined, maxGradeId: 17 };

describe('RANGE_EXTEND_WINDOW_MS', () => {
  it('is the three seconds the help page tells climbers', () => {
    expect(RANGE_EXTEND_WINDOW_MS).toBe(3000);
  });
});

describe('grade-bound predicates', () => {
  it('isAnyGrade is true only when both bounds are undefined', () => {
    expect(isAnyGrade(any)).toBe(true);
    expect(isAnyGrade(onlyV3)).toBe(false);
    expect(isAnyGrade(fromV4Up)).toBe(false);
    expect(isAnyGrade(upToV4)).toBe(false);
  });

  it('clearGradeBound returns both-undefined', () => {
    expect(clearGradeBound()).toEqual({ minGradeId: undefined, maxGradeId: undefined });
    expect(isAnyGrade(clearGradeBound())).toBe(true);
  });

  it('isSameGradeBound compares both ends', () => {
    expect(isSameGradeBound(v2ToV5, { minGradeId: 15, maxGradeId: 18 })).toBe(true);
    expect(isSameGradeBound(any, clearGradeBound())).toBe(true);
    expect(isSameGradeBound(v2ToV5, { minGradeId: 15, maxGradeId: 19 })).toBe(false);
    expect(isSameGradeBound(v2ToV5, { minGradeId: 16, maxGradeId: 18 })).toBe(false);
    expect(isSameGradeBound(fromV4Up, upToV4)).toBe(false);
  });
});

describe('grade stops', () => {
  it('findGradeStop finds the stop covering an id, at its edges and inside', () => {
    expect(findGradeStop(stops, 10)).toBe(V0);
    expect(findGradeStop(stops, 11)).toBe(V0);
    expect(findGradeStop(stops, 12)).toBe(V0);
    expect(findGradeStop(stops, 13)).toBe(V1);
    expect(findGradeStop(stops, 19)).toBe(V6);
  });

  it('findGradeStop returns undefined for an id with no stop', () => {
    expect(findGradeStop(stops, 9)).toBeUndefined();
    expect(findGradeStop(stops, 25)).toBeUndefined();
    expect(findGradeStop([], 15)).toBeUndefined();
  });

  it('isGradeStopEnd is true for the stop either end falls in', () => {
    expect(isGradeStopEnd(v2ToV5, V2)).toBe(true);
    expect(isGradeStopEnd(v2ToV5, V5)).toBe(true);
    expect(isGradeStopEnd(v2ToV5, V3)).toBe(false);
    expect(isGradeStopEnd(v2ToV5, V6)).toBe(false);
    // An end inside a group still makes the whole stop an end.
    expect(isGradeStopEnd(insideV0, V0)).toBe(true);
    expect(isGradeStopEnd(fromV4Up, V4)).toBe(true);
    expect(isGradeStopEnd(upToV4, V4)).toBe(true);
    expect(isGradeStopEnd(any, V4)).toBe(false);
  });

  it('isGradeStopAlone needs both ends set and inside the stop', () => {
    expect(isGradeStopAlone(onlyV3, V3)).toBe(true);
    expect(isGradeStopAlone(onlyV0, V0)).toBe(true);
    expect(isGradeStopAlone(insideV0, V0)).toBe(true);
    expect(isGradeStopAlone({ minGradeId: 10, maxGradeId: 11 }, V0)).toBe(true);
    expect(isGradeStopAlone(onlyV3, V4)).toBe(false);
    expect(isGradeStopAlone(v2ToV5, V2)).toBe(false);
    expect(isGradeStopAlone(fromV4Up, V4)).toBe(false);
    expect(isGradeStopAlone(upToV4, V4)).toBe(false);
    expect(isGradeStopAlone(any, V4)).toBe(false);
  });

  it('isGradeStopInRange is true only strictly between the two ends', () => {
    expect(isGradeStopInRange(v2ToV5, V3)).toBe(true);
    expect(isGradeStopInRange(v2ToV5, V4)).toBe(true);
    expect(isGradeStopInRange(v2ToV5, V2)).toBe(false); // lower end
    expect(isGradeStopInRange(v2ToV5, V5)).toBe(false); // upper end
    expect(isGradeStopInRange(v2ToV5, V1)).toBe(false); // below
    expect(isGradeStopInRange(v2ToV5, V6)).toBe(false); // above
    expect(isGradeStopInRange(onlyV3, V3)).toBe(false);
    expect(isGradeStopInRange(fromV4Up, V5)).toBe(false);
    expect(isGradeStopInRange(any, V3)).toBe(false);
  });

  it('isGradeStopInRange keeps a group an end when the range starts inside it', () => {
    const fromInsideV0: GradeBound = { minGradeId: 11, maxGradeId: 16 };
    expect(isGradeStopEnd(fromInsideV0, V0)).toBe(true);
    expect(isGradeStopInRange(fromInsideV0, V0)).toBe(false);
    expect(isGradeStopInRange(fromInsideV0, V1)).toBe(true);
  });

  it('findSelectedGradeStop finds the stop that is the whole selection', () => {
    expect(findSelectedGradeStop(onlyV3, stops)).toBe(V3);
    expect(findSelectedGradeStop(onlyV0, stops)).toBe(V0);
    expect(findSelectedGradeStop(insideV0, stops)).toBe(V0);
  });

  it('findSelectedGradeStop finds none for Any, a range or an open-ended bound', () => {
    expect(findSelectedGradeStop(any, stops)).toBeUndefined();
    expect(findSelectedGradeStop(v2ToV5, stops)).toBeUndefined();
    expect(findSelectedGradeStop(fromV4Up, stops)).toBeUndefined();
    expect(findSelectedGradeStop({ minGradeId: 25, maxGradeId: 25 }, stops)).toBeUndefined();
  });
});

// `withinExtendWindow` only matters with one stop selected and a different one
// tapped. Every other case is checked with the window both open and shut.
describe('computeGradeTap', () => {
  describe.each([
    ['inside the extend window', true],
    ['after the extend window', false],
  ])('%s', (_when, withinExtendWindow) => {
    const tap = (current: GradeBound, tapped: GradeStop) => computeGradeTap(current, tapped, stops, withinExtendWindow);

    it('picks the tapped stop from Any', () => {
      expect(tap(any, V3)).toEqual({ minGradeId: 16, maxGradeId: 16 });
    });

    it('takes a grouped stop from its lowest id to its highest', () => {
      expect(tap(any, V0)).toEqual({ minGradeId: 10, maxGradeId: 12 });
    });

    it('clears to Any when the selected stop is tapped again', () => {
      expect(tap(onlyV3, V3)).toEqual(any);
      expect(tap(onlyV0, V0)).toEqual(any);
    });

    it('clears when the selection sits inside the tapped group', () => {
      expect(tap(insideV0, V0)).toEqual(any);
    });

    it('replaces an open-ended bound with the tapped stop, also on its set end', () => {
      expect(tap(fromV4Up, V6)).toEqual({ minGradeId: 19, maxGradeId: 19 });
      expect(tap(fromV4Up, V4)).toEqual({ minGradeId: 17, maxGradeId: 17 });
      expect(tap(upToV4, V4)).toEqual({ minGradeId: 17, maxGradeId: 17 });
    });

    describe('with a range set', () => {
      it('moves the lower end one stop inward when it is tapped', () => {
        expect(tap(v2ToV5, V2)).toEqual({ minGradeId: 16, maxGradeId: 18 });
      });

      it('moves the upper end one stop inward when it is tapped', () => {
        expect(tap(v2ToV5, V5)).toEqual({ minGradeId: 15, maxGradeId: 17 });
      });

      it('steps over a whole grouped stop, not one grade id', () => {
        const v0ToV3: GradeBound = { minGradeId: 10, maxGradeId: 16 };
        expect(tap(v0ToV3, V0)).toEqual({ minGradeId: 13, maxGradeId: 16 });
        const v1ToV3: GradeBound = { minGradeId: 13, maxGradeId: 16 };
        expect(tap(v1ToV3, V1)).toEqual({ minGradeId: 15, maxGradeId: 16 });
      });

      it('settles on the other end when the two ends are neighbours', () => {
        const v2ToV3: GradeBound = { minGradeId: 15, maxGradeId: 16 };
        expect(tap(v2ToV3, V2)).toEqual({ minGradeId: 16, maxGradeId: 16 });
        expect(tap(v2ToV3, V3)).toEqual({ minGradeId: 15, maxGradeId: 15 });
        const v0ToV1: GradeBound = { minGradeId: 10, maxGradeId: 14 };
        expect(tap(v0ToV1, V0)).toEqual({ minGradeId: 13, maxGradeId: 14 });
        expect(tap(v0ToV1, V1)).toEqual({ minGradeId: 10, maxGradeId: 12 });
      });

      it('collapses to an interior stop that is tapped', () => {
        expect(tap(v2ToV5, V3)).toEqual({ minGradeId: 16, maxGradeId: 16 });
        expect(tap(v2ToV5, V4)).toEqual({ minGradeId: 17, maxGradeId: 17 });
      });

      it('collapses to a stop outside the range that is tapped', () => {
        expect(tap(v2ToV5, V0)).toEqual({ minGradeId: 10, maxGradeId: 12 });
        expect(tap(v2ToV5, V6)).toEqual({ minGradeId: 19, maxGradeId: 19 });
      });

      it('trims from the whole stop when an end sits inside a group, and widens the end it keeps', () => {
        const fromInsideV0: GradeBound = { minGradeId: 11, maxGradeId: 16 };
        expect(tap(fromInsideV0, V0)).toEqual({ minGradeId: 13, maxGradeId: 16 });
        expect(tap(fromInsideV0, V3)).toEqual({ minGradeId: 10, maxGradeId: 15 });
      });

      it('settles on the other end when the row has no stop further in', () => {
        // The upper end is an id with no chip, above the last stop.
        const v6ToUnknown: GradeBound = { minGradeId: 19, maxGradeId: 25 };
        expect(tap(v6ToUnknown, V6)).toEqual({ minGradeId: 25, maxGradeId: 25 });
      });

      it('settles on the other end when the next stop in would pass it', () => {
        // A scale with a hole: no chip for 17, and the range ends on it.
        const rowWithHole: GradeStop[] = [V2, V3, V5];
        const v3To17: GradeBound = { minGradeId: 16, maxGradeId: 17 };
        expect(computeGradeTap(v3To17, V3, rowWithHole, withinExtendWindow)).toEqual({
          minGradeId: 17,
          maxGradeId: 17,
        });
        const from17ToV5: GradeBound = { minGradeId: 17, maxGradeId: 18 };
        expect(computeGradeTap(from17ToV5, V5, rowWithHole, withinExtendWindow)).toEqual({
          minGradeId: 17,
          maxGradeId: 17,
        });
      });
    });
  });

  describe('with one stop selected and a different stop tapped', () => {
    it('makes the range covering both inside the window (tapping higher)', () => {
      expect(computeGradeTap(onlyV3, V5, stops, true)).toEqual({ minGradeId: 16, maxGradeId: 18 });
    });

    it('makes the range in ascending order inside the window (tapping lower)', () => {
      expect(computeGradeTap(onlyV3, V2, stops, true)).toEqual({ minGradeId: 15, maxGradeId: 16 });
    });

    it('covers the whole of a grouped stop at either end of the range', () => {
      expect(computeGradeTap(onlyV3, V0, stops, true)).toEqual({ minGradeId: 10, maxGradeId: 16 });
      expect(computeGradeTap(onlyV0, V3, stops, true)).toEqual({ minGradeId: 10, maxGradeId: 16 });
    });

    it('widens a selection saved inside a group to the group edge inside the window', () => {
      expect(computeGradeTap(insideV0, V3, stops, true)).toEqual({ minGradeId: 10, maxGradeId: 16 });
    });

    it('switches to the tapped stop after the window', () => {
      expect(computeGradeTap(onlyV3, V5, stops, false)).toEqual({ minGradeId: 18, maxGradeId: 18 });
      expect(computeGradeTap(onlyV3, V0, stops, false)).toEqual({ minGradeId: 10, maxGradeId: 12 });
      expect(computeGradeTap(insideV0, V3, stops, false)).toEqual({ minGradeId: 16, maxGradeId: 16 });
    });

    it('treats a selection with no stop of its own as the one selected stop', () => {
      const unknownGrade: GradeBound = { minGradeId: 25, maxGradeId: 25 };
      expect(computeGradeTap(unknownGrade, V5, stops, true)).toEqual({ minGradeId: 18, maxGradeId: 25 });
      expect(computeGradeTap(unknownGrade, V5, stops, false)).toEqual({ minGradeId: 18, maxGradeId: 18 });
    });
  });
});

describe('extendGradeRange (a touch and hold)', () => {
  it('makes the held stop the first end from Any', () => {
    expect(extendGradeRange(any, V3, stops)).toEqual({ minGradeId: 16, maxGradeId: 16 });
    expect(extendGradeRange(any, V0, stops)).toEqual({ minGradeId: 10, maxGradeId: 12 });
  });

  it('clears when the stop that is the whole selection is held', () => {
    expect(extendGradeRange(onlyV3, V3, stops)).toEqual(any);
    expect(extendGradeRange(onlyV0, V0, stops)).toEqual(any);
    expect(extendGradeRange(insideV0, V0, stops)).toEqual(any);
  });

  describe('from one stop', () => {
    it('covers it and a higher stop', () => {
      expect(extendGradeRange(onlyV3, V5, stops)).toEqual({ minGradeId: 16, maxGradeId: 18 });
    });

    it('covers it and a lower stop, in ascending order', () => {
      expect(extendGradeRange(onlyV3, V2, stops)).toEqual({ minGradeId: 15, maxGradeId: 16 });
    });

    it('covers the whole of a grouped stop at either end', () => {
      expect(extendGradeRange(onlyV3, V0, stops)).toEqual({ minGradeId: 10, maxGradeId: 16 });
      expect(extendGradeRange(onlyV0, V3, stops)).toEqual({ minGradeId: 10, maxGradeId: 16 });
      expect(extendGradeRange(onlyV0, V1, stops)).toEqual({ minGradeId: 10, maxGradeId: 14 });
    });

    it('widens a selection saved inside a group to the group edge it keeps', () => {
      expect(extendGradeRange(insideV0, V3, stops)).toEqual({ minGradeId: 10, maxGradeId: 16 });
    });

    it('keeps a selection with no stop as its own end', () => {
      expect(extendGradeRange({ minGradeId: 25, maxGradeId: 25 }, V5, stops)).toEqual({
        minGradeId: 18,
        maxGradeId: 25,
      });
    });
  });

  describe('from an open-ended bound', () => {
    it('closes it into the range covering its set end and the tapped stop', () => {
      expect(extendGradeRange(fromV4Up, V6, stops)).toEqual({ minGradeId: 17, maxGradeId: 19 });
      expect(extendGradeRange(fromV4Up, V2, stops)).toEqual({ minGradeId: 15, maxGradeId: 17 });
      expect(extendGradeRange(upToV4, V0, stops)).toEqual({ minGradeId: 10, maxGradeId: 17 });
    });

    it('settles on the stop of its set end when that stop is tapped', () => {
      expect(extendGradeRange(fromV4Up, V4, stops)).toEqual({ minGradeId: 17, maxGradeId: 17 });
      expect(extendGradeRange(upToV4, V4, stops)).toEqual({ minGradeId: 17, maxGradeId: 17 });
    });
  });

  describe('with a range set', () => {
    it('moves the lower end to a stop nearer to it, inside the range', () => {
      expect(extendGradeRange(v2ToV5, V3, stops)).toEqual({ minGradeId: 16, maxGradeId: 18 });
    });

    it('moves the upper end to a stop nearer to it, inside the range', () => {
      expect(extendGradeRange(v2ToV5, V4, stops)).toEqual({ minGradeId: 15, maxGradeId: 17 });
    });

    it('extends the lower end to a stop below the range', () => {
      expect(extendGradeRange(v2ToV5, V0, stops)).toEqual({ minGradeId: 10, maxGradeId: 18 });
      expect(extendGradeRange(v2ToV5, V1, stops)).toEqual({ minGradeId: 13, maxGradeId: 18 });
    });

    it('extends the upper end to a stop above the range', () => {
      expect(extendGradeRange(v2ToV5, V6, stops)).toEqual({ minGradeId: 15, maxGradeId: 19 });
    });

    it('moves the upper end when the stop is equally far from both', () => {
      const v2ToV4: GradeBound = { minGradeId: 15, maxGradeId: 17 };
      expect(extendGradeRange(v2ToV4, V3, stops)).toEqual({ minGradeId: 15, maxGradeId: 16 });
    });

    it('leaves the range as it is when an end is tapped', () => {
      expect(isSameGradeBound(extendGradeRange(v2ToV5, V2, stops), v2ToV5)).toBe(true);
      expect(isSameGradeBound(extendGradeRange(v2ToV5, V5, stops), v2ToV5)).toBe(true);
    });

    it('counts distance in stops, not in grade ids', () => {
      // V0 to V3: V1 is one stop from V0 and two from V3, though its ids sit
      // nearer to V3's (13 and 14 against 10 and 16).
      const v0ToV3: GradeBound = { minGradeId: 10, maxGradeId: 16 };
      expect(extendGradeRange(v0ToV3, V1, stops)).toEqual({ minGradeId: 13, maxGradeId: 16 });
    });

    it('widens a kept end that sits inside a group to the group edge', () => {
      const fromInsideV0: GradeBound = { minGradeId: 11, maxGradeId: 18 };
      expect(extendGradeRange(fromInsideV0, V4, stops)).toEqual({ minGradeId: 10, maxGradeId: 17 });
    });

    it('places an end with no stop above the row, and moves it when it is the nearer one', () => {
      const v2ToUnknown: GradeBound = { minGradeId: 15, maxGradeId: 25 };
      expect(extendGradeRange(v2ToUnknown, V6, stops)).toEqual({ minGradeId: 15, maxGradeId: 19 });
      expect(extendGradeRange(v2ToUnknown, V3, stops)).toEqual({ minGradeId: 16, maxGradeId: 25 });
    });
  });
});
