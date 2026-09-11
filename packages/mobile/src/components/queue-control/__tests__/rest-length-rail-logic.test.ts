// The two rules that make the rest-length rail safe to replace a stepper with:
// every chip's label IS its value in ONE notation, and a persisted value the
// rail doesn't happen to carry is spliced in rather than snapped away.
import { describe, expect, it } from 'vitest';
import {
  REST_LENGTH_OFF,
  REST_LENGTH_RAIL_SECONDS,
  formatRestLengthChipLabel,
  hasRestLength,
  restLengthRailSeconds,
} from '../rest-length-rail.logic';

describe('REST_LENGTH_RAIL_SECONDS', () => {
  it('is strictly ascending, so a spliced value has one unambiguous position', () => {
    const sorted = [...REST_LENGTH_RAIL_SECONDS].sort((first, second) => first - second);
    expect([...REST_LENGTH_RAIL_SECONDS]).toEqual(sorted);
    expect(new Set(REST_LENGTH_RAIL_SECONDS).size).toBe(REST_LENGTH_RAIL_SECONDS.length);
  });

  it('never contains the Off id, so the rail can be keyed by seconds alone', () => {
    expect(REST_LENGTH_RAIL_SECONDS).not.toContain(REST_LENGTH_OFF);
    expect(REST_LENGTH_RAIL_SECONDS.every((seconds) => seconds > 0)).toBe(true);
  });

  it('covers 15 seconds to an hour', () => {
    expect(REST_LENGTH_RAIL_SECONDS[0]).toBe(15);
    expect(REST_LENGTH_RAIL_SECONDS[REST_LENGTH_RAIL_SECONDS.length - 1]).toBe(3600);
  });
});

describe('restLengthRailSeconds', () => {
  it('is the plain domain for Off', () => {
    expect(restLengthRailSeconds(null)).toEqual([...REST_LENGTH_RAIL_SECONDS]);
  });

  it('is the plain domain for a value already on the rail', () => {
    expect(restLengthRailSeconds(180)).toEqual([...REST_LENGTH_RAIL_SECONDS]);
  });

  it('splices an off-rail value in at its sorted position rather than snapping it away', () => {
    const rail = restLengthRailSeconds(100);

    expect(rail).toContain(100);
    expect(rail).toHaveLength(REST_LENGTH_RAIL_SECONDS.length + 1);
    // Between 90 and 105 — the two chips it sits between on the fine-grained run.
    expect(rail.indexOf(100)).toBe(rail.indexOf(90) + 1);
    expect(rail[rail.indexOf(100) + 1]).toBe(105);
    expect([...rail].sort((first, second) => first - second)).toEqual(rail);
  });

  it('splices a value past the end of the rail', () => {
    const rail = restLengthRailSeconds(5400);
    expect(rail[rail.length - 1]).toBe(5400);
  });

  it('ignores a value that is not a real rest length', () => {
    expect(restLengthRailSeconds(0)).toEqual([...REST_LENGTH_RAIL_SECONDS]);
    expect(restLengthRailSeconds(-30)).toEqual([...REST_LENGTH_RAIL_SECONDS]);
    expect(restLengthRailSeconds(Number.NaN)).toEqual([...REST_LENGTH_RAIL_SECONDS]);
  });
});

describe('formatRestLengthChipLabel', () => {
  it('keeps ONE notation down the rail — never the compact target format', () => {
    // The bug this guards: `formatRestTimerTarget` renders whole minutes as "2m",
    // so a rail built from it reads `1:45 · 2m · 2:15` and has no column of
    // digits to scan.
    expect(formatRestLengthChipLabel(120)).toBe('2:00');
    expect(formatRestLengthChipLabel(105)).toBe('1:45');
    expect(formatRestLengthChipLabel(15)).toBe('0:15');
    expect(formatRestLengthChipLabel(3600)).toBe('1:00:00');
  });

  it('labels every chip on the rail', () => {
    const labels = REST_LENGTH_RAIL_SECONDS.map(formatRestLengthChipLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => /^\d+:\d{2}(:\d{2})?$/.test(label))).toBe(true);
  });
});

describe('hasRestLength', () => {
  it('treats Off and a zero-length rest as no deadline at all', () => {
    expect(hasRestLength(null)).toBe(false);
    expect(hasRestLength(0)).toBe(false);
    expect(hasRestLength(-1)).toBe(false);
  });

  it('accepts any positive rest length, on the rail or spliced in', () => {
    expect(hasRestLength(15)).toBe(true);
    expect(hasRestLength(100)).toBe(true);
  });
});
