import type { LedPosition, TnutWiring } from '@boardsesh/spray-wall-geometry';
import { describe, expect, it } from 'vitest';
import { sprayCableDisplayGeometry } from '../spray-cable-display';

const leds: LedPosition[] = [
  { id: 'lead', x: 0.5, y: 0.25 },
  { id: 'left', x: 0.25, y: 0.5 },
  { id: 'right', x: 0.75, y: 0.5 },
  { id: 'tail', x: 0.5, y: 0.75 },
];
const wiring: TnutWiring = {
  direction: 'custom',
  startCorner: 'tl',
  paths: [['lead', 'left', 'right', 'tail']],
  skips: [],
};
const pairs = [['left', 'right']] as const;

describe('Spraywall cable display geometry', () => {
  it('uses the midpoint while retaining the two visible edges’ physical IDs and skips', () => {
    const display = sprayCableDisplayGeometry(
      leds,
      { ...wiring, skips: [{ from: 'tail', to: 'right', count: 2 }] },
      pairs,
    );
    expect(display.edges).toEqual([
      {
        fromId: 'lead',
        toId: 'left',
        from: { x: 0.5, y: 0.25 },
        to: { x: 0.5, y: 0.5 },
        skip: 0,
        first: true,
      },
      {
        fromId: 'right',
        toId: 'tail',
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.5, y: 0.75 },
        skip: 2,
        first: false,
      },
    ]);
  });

  it('puts the start and first arrow at the shared point when a pair starts the cable', () => {
    const display = sprayCableDisplayGeometry(leds, { ...wiring, paths: [['right', 'left', 'tail']] }, pairs);
    expect(display.start).toEqual({ x: 0.5, y: 0.5 });
    expect(display.edges).toMatchObject([{ fromId: 'left', from: { x: 0.5, y: 0.5 }, first: true }]);
    const onlyPair = sprayCableDisplayGeometry(leds, { ...wiring, paths: [['right', 'left']] }, pairs);
    expect(onlyPair.start).toEqual({ x: 0.5, y: 0.5 });
    expect(onlyPair.end).toBeUndefined();
  });

  it('keeps a skipped edge within a pair editable at its physical positions', () => {
    const display = sprayCableDisplayGeometry(
      leds,
      { ...wiring, skips: [{ from: 'right', to: 'left', count: 1 }] },
      pairs,
    );
    expect(display.edges[1]).toMatchObject({
      fromId: 'left',
      toId: 'right',
      from: { x: 0.25, y: 0.5 },
      to: { x: 0.75, y: 0.5 },
      skip: 1,
    });
  });

  it('keeps physical anchors when pair members are in separate cable sections', () => {
    const display = sprayCableDisplayGeometry(
      leds,
      {
        ...wiring,
        paths: [
          ['lead', 'left'],
          ['right', 'tail'],
        ],
      },
      pairs,
    );
    expect(display.loose).toEqual([
      { x: 0.25, y: 0.5 },
      { x: 0.75, y: 0.5 },
    ]);
    expect(display.edges[0].to).toEqual({ x: 0.25, y: 0.5 });
    expect(display.edges[1].from).toEqual({ x: 0.75, y: 0.5 });
  });
});
