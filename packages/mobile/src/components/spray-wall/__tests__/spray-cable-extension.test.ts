import { describe, expect, it } from 'vitest';
import { assignLedIndices, MAX_LED_POSITIONS, type TnutWiring } from '@boardsesh/spray-wall-geometry';
import { planCableExtension } from '../spray-cable-extension';

const wiring: TnutWiring = {
  direction: 'custom',
  startCorner: 'tl',
  initialSkip: 3,
  paths: [
    ['a', 'b'],
    ['c', 'd'],
    ['e', 'f'],
  ],
  skips: [
    { from: 'a', to: 'b', count: 2 },
    { from: 'd', to: 'c', count: 4 },
    { from: 'e', to: 'f', count: 1 },
  ],
};
const noUnits = new Map<string, readonly string[]>();
const noStrips = new Set<string>();

describe('Lay cable reconnections', () => {
  it('joins a later input without changing physical order, initial skips or internal gaps', () => {
    const plan = planCableExtension(wiring, ['c'], 'b', noUnits, noStrips);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toEqual({
      ...wiring,
      paths: [
        ['a', 'b', 'c', 'd'],
        ['e', 'f'],
      ],
    });
    expect(assignLedIndices(plan.steps[0])).toEqual(assignLedIndices(wiring));
    expect(plan.output).toEqual({ sectionStart: 'a', tail: 'd' });
    expect(wiring.paths).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('appends, joins and continues with a distinct Undo stop for each edit', () => {
    const plan = planCableExtension(wiring, ['b', 'new', 'c', 'last'], undefined, noUnits, noStrips);
    expect(plan.steps.map(({ paths }) => paths)).toEqual([
      [
        ['a', 'b', 'new'],
        ['c', 'd'],
        ['e', 'f'],
      ],
      [
        ['a', 'b', 'new', 'c', 'd'],
        ['e', 'f'],
      ],
      [
        ['a', 'b', 'new', 'c', 'd', 'last'],
        ['e', 'f'],
      ],
    ]);
    expect(plan.output).toEqual({ sectionStart: 'a', tail: 'last' });
    for (const step of plan.steps) expect(step.skips).toEqual(wiring.skips);
  });

  it('previews the same multi-join route while keeping only the final snapshot', () => {
    const ids = ['b', 'new', 'c', 'last', 'e', 'end'];
    const committed = planCableExtension(wiring, ids, undefined, noUnits, noStrips);
    const preview = planCableExtension(wiring, ids, undefined, noUnits, noStrips, { recordStops: false });
    expect(committed.steps).toHaveLength(5);
    expect(preview.steps).toEqual([committed.steps.at(-1)]);
    expect(preview.output).toEqual(committed.output);
    expect(preview.steps[0].paths).toEqual([['a', 'b', 'new', 'c', 'd', 'last', 'e', 'f', 'end']]);
    expect(preview.steps[0].skips).toEqual(wiring.skips);
  });

  it('keeps unrelated sections when joining a nonadjacent later section', () => {
    const plan = planCableExtension(wiring, ['b', 'e'], undefined, noUnits, noStrips);
    expect(plan.steps.at(-1)?.paths).toEqual([
      ['a', 'b', 'e', 'f'],
      ['c', 'd'],
    ]);
    expect(plan.output).toEqual({ sectionStart: 'a', tail: 'f' });
  });

  it.each([
    ['a', 'b'],
    ['c', 'd'],
    ['missing', 'a'],
  ])('does not branch, loop or silently switch a stale source %s to %s', (source, target) => {
    const plan = planCableExtension(wiring, [target], source, noUnits, noStrips, { startAtHit: false });
    expect(plan.steps).toEqual([]);
  });

  it('never joins a later output back to the controller input', () => {
    expect(planCableExtension(wiring, ['f', 'a'], undefined, noUnits, noStrips).steps).toEqual([]);
  });

  it('ignores a wired interior and a backwards connection while extending the selected section', () => {
    const interior = {
      ...wiring,
      paths: [
        ['a', 'inside', 'b'],
        ['c', 'd'],
        ['e', 'f'],
      ],
    };
    const plan = planCableExtension(interior, ['d', 'inside', 'a', 'new'], undefined, noUnits, noStrips);
    expect(plan.steps.at(-1)?.paths).toEqual([
      ['a', 'inside', 'b'],
      ['c', 'd', 'new'],
      ['e', 'f'],
    ]);
  });

  it.each([{ pair: ['c', 'd'] }, { pair: ['d', 'c'] }])(
    'joins a complete input pair in its saved order $pair',
    ({ pair }) => {
      const units = new Map(pair.map((id) => [id, pair]));
      const plan = planCableExtension(wiring, [pair[1]], 'b', units, noStrips, { startAtHit: false });
      expect(plan.steps.at(-1)?.paths).toEqual([
        ['a', 'b', 'c', 'd'],
        ['e', 'f'],
      ]);
      expect(plan.output).toEqual({ sectionStart: 'a', tail: 'd' });
    },
  );

  it('lets a drag start at a whole pair output despite a different selected section', () => {
    const pair = ['c', 'd'];
    const units = new Map(pair.map((id) => [id, pair]));
    const plan = planCableExtension(wiring, ['c', 'new'], 'b', units, noStrips);
    expect(plan.steps.at(-1)?.paths).toEqual([
      ['a', 'b'],
      ['c', 'd', 'new'],
      ['e', 'f'],
    ]);
  });

  it('joins a whole strip through its middle without splitting or reversing it', () => {
    const strip = ['c', 'middle', 'd'];
    const layout = { ...wiring, paths: [['a', 'b'], [...strip].reverse()] };
    const units = new Map(strip.map((id) => [id, strip]));
    const plan = planCableExtension(layout, ['middle'], 'b', units, new Set(strip), { startAtHit: false });
    expect(plan.steps.at(-1)?.paths).toEqual([['a', 'b', 'd', 'middle', 'c']]);
    expect(plan.output).toEqual({ sectionStart: 'a', tail: 'c' });
  });

  it('joins a single-LED section by tap but still selects it as a drag source', () => {
    const layout = { ...wiring, paths: [['a', 'b'], ['c']] };
    const tap = planCableExtension(layout, ['c'], 'b', noUnits, noStrips, { startAtHit: false });
    expect(tap.steps.at(-1)?.paths).toEqual([['a', 'b', 'c']]);
    const drag = planCableExtension(layout, ['c', 'new'], 'b', noUnits, noStrips);
    expect(drag.steps.at(-1)?.paths).toEqual([
      ['a', 'b'],
      ['c', 'new'],
    ]);
  });

  it.each([
    [['c', 'd'], ['a', 'b'], ['c'], ['d', 'e', 'f']],
    [
      ['c', 'e', 'd'],
      ['a', 'b'],
      ['c', 'd', 'e', 'f'],
    ],
  ])('does not join split or reordered legacy units %j', (unit, ...paths) => {
    const units = new Map(unit.map((id) => [id, unit]));
    const layout = { ...wiring, paths };
    expect(planCableExtension(layout, [unit[0]], 'b', units, noStrips, { startAtHit: false }).steps).toEqual([]);
  });

  it('can reconnect at LED capacity without allocating another physical position', () => {
    const ids = Array.from({ length: MAX_LED_POSITIONS }, (_, index) => `led-${index}`);
    const layout = { ...wiring, paths: [ids.slice(0, 2), ids.slice(2)], skips: [] };
    const plan = planCableExtension(layout, [ids[1], 'extra', ids[2]], undefined, noUnits, noStrips);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].paths).toEqual([ids]);
  });
});
