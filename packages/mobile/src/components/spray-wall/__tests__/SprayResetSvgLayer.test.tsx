// @vitest-environment jsdom
//
// The compare view's rings, which are the whole decision.
//
// An owner confirms a reset by reading this layer: green means the hold is
// staying, red means it is coming off, blue means something new, amber means the
// matcher was unsure. Get a bucket wrong and somebody takes holds off a wall
// they meant to keep. Two properties are worth pinning:
//
//  1. every verdict has its own colour AND its own dash pattern. A reset decided
//     from colour alone is a reset a colour-blind owner cannot make;
//  2. the filter reaches the drawing, not just the tap targets — a ring the
//     filter has hidden must not be painted.

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles },
}));

// Each `<Path>` becomes a span carrying the three things under test: what was
// drawn, in what colour, with what dash.
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('svg', {}, children),
  Path: ({ d, stroke, strokeDasharray }: { d?: string; stroke?: string; strokeDasharray?: number[] }) =>
    createElement('path', {
      'data-d': d ?? '',
      'data-stroke': stroke,
      'data-dash': strokeDasharray ? strokeDasharray.join(',') : '',
    }),
}));

const { SprayResetSvgLayer, SPRAY_RESET_COLORS } = await import('../SprayResetSvgLayer');
const { initialResetReviewState, resetReviewReducer } = await import('../reset-review-machine');
import type { ResetDetection, ResetProposal } from '../reset-review-machine';

const HOLDS = [
  { id: 11, cx: 100, cy: 100, r: 10 },
  { id: 12, cx: 200, cy: 200, r: 10 },
  { id: 13, cx: 300, cy: 300, r: 10 },
];

const DETECTIONS: ResetDetection[] = [0, 1, 2].map((index) => ({
  photo: { cx: 400 + index * 10, cy: 400, r: 8, outline: null },
  canonical: { cx: 400 + index * 10, cy: 400, r: 8, outline: null },
  confidence: 0.8,
}));

/** Hold 11 kept, 12 kept-but-unsure, 13 removed; detection 2 is the new hold. */
const PROPOSAL: ResetProposal = {
  kept: [
    { holdId: 11, detectionIndex: 0, confidence: 0.95 },
    { holdId: 12, detectionIndex: 1, confidence: 0.6 },
  ],
  removed: [13],
  added: [2],
  lowConfidence: [12],
  climbsAffected: 1,
  movesSuggested: [],
  aspectMismatch: false,
};

const seeded = () => initialResetReviewState(PROPOSAL, [11, 12, 13], DETECTIONS.length);

function renderLayer(review = seeded(), selectedKey: number | null = null) {
  const { container } = render(
    createElement(SprayResetSvgLayer, {
      holds: HOLDS,
      detections: DETECTIONS,
      review,
      selectedKey,
      boardWidth: 1000,
      boardHeight: 1000,
      renderWidth: 500,
      renderHeight: 500,
    }),
  );
  return [...container.querySelectorAll('path')].map((node) => ({
    d: node.getAttribute('data-d') ?? '',
    stroke: node.getAttribute('data-stroke'),
    dash: node.getAttribute('data-dash'),
  }));
}

/** The bucket drawn in one role's colour. */
const bucket = (paths: ReturnType<typeof renderLayer>, colour: string) =>
  paths.find((path) => path.stroke === colour) ?? { d: '', stroke: null, dash: '' };

describe('SprayResetSvgLayer', () => {
  it('draws each verdict in its own colour', () => {
    const paths = renderLayer();

    expect(bucket(paths, SPRAY_RESET_COLORS.kept).d).not.toBe('');
    expect(bucket(paths, SPRAY_RESET_COLORS.lowConfidence).d).not.toBe('');
    expect(bucket(paths, SPRAY_RESET_COLORS.removed).d).not.toBe('');
    expect(bucket(paths, SPRAY_RESET_COLORS.added).d).not.toBe('');

    // Four distinct colours, not one reused.
    const roleColours = new Set([
      SPRAY_RESET_COLORS.kept,
      SPRAY_RESET_COLORS.removed,
      SPRAY_RESET_COLORS.added,
      SPRAY_RESET_COLORS.lowConfidence,
    ]);
    expect(roleColours.size).toBe(4);
  });

  it('distinguishes the verdicts by dash as well, so colour is not the only signal', () => {
    const paths = renderLayer();

    const kept = bucket(paths, SPRAY_RESET_COLORS.kept);
    const removed = bucket(paths, SPRAY_RESET_COLORS.removed);
    const added = bucket(paths, SPRAY_RESET_COLORS.added);
    const unsure = bucket(paths, SPRAY_RESET_COLORS.lowConfidence);

    // Kept is the only solid one — a wall where nothing changed reads as calm.
    expect(kept.dash).toBe('');
    for (const dashed of [removed, added, unsure]) expect(dashed.dash).not.toBe('');
    // And the three dashed roles do not share a pattern.
    expect(new Set([removed.dash, added.dash, unsure.dash]).size).toBe(3);
  });

  it('paints a hold the owner has put back in the kept bucket', () => {
    const before = renderLayer();
    const removedBefore = bucket(before, SPRAY_RESET_COLORS.removed).d;
    expect(removedBefore).not.toBe('');

    const putBack = resetReviewReducer(seeded(), { type: 'TOGGLE_HOLD', holdId: 13 });
    const after = renderLayer(putBack);

    expect(bucket(after, SPRAY_RESET_COLORS.removed).d).toBe('');
    expect(bucket(after, SPRAY_RESET_COLORS.kept).d).not.toBe(bucket(before, SPRAY_RESET_COLORS.kept).d);
  });

  it('draws nothing the filter has hidden', () => {
    const removedOnly = resetReviewReducer(seeded(), { type: 'SET_FILTER', filter: 'removed' });
    const paths = renderLayer(removedOnly);

    expect(bucket(paths, SPRAY_RESET_COLORS.removed).d).not.toBe('');
    expect(bucket(paths, SPRAY_RESET_COLORS.kept).d).toBe('');
    expect(bucket(paths, SPRAY_RESET_COLORS.lowConfidence).d).toBe('');
    expect(bucket(paths, SPRAY_RESET_COLORS.added).d).toBe('');
  });

  it('never draws a detection that IS a hold already on the wall', () => {
    // Detections 0 and 1 are holds 11 and 12 seen again in the new photo. Drawing
    // them would put a second ring on top of every kept hold.
    const paths = renderLayer();
    const rejected = bucket(paths, SPRAY_RESET_COLORS.rejected);
    expect(rejected.d).toBe('');
  });

  it('marks the ring under the finger, on either side of the selection key', () => {
    const noSelection = bucket(renderLayer(), SPRAY_RESET_COLORS.selected).d;
    expect(noSelection).toBe('');

    // A positive key is a hold; `-(index + 1)` is a detection.
    expect(bucket(renderLayer(seeded(), 13), SPRAY_RESET_COLORS.selected).d).not.toBe('');
    expect(bucket(renderLayer(seeded(), -3), SPRAY_RESET_COLORS.selected).d).not.toBe('');
  });

  it('draws nothing at all before the board has a size', () => {
    const { container } = render(
      createElement(SprayResetSvgLayer, {
        holds: HOLDS,
        detections: DETECTIONS,
        review: seeded(),
        selectedKey: null,
        boardWidth: 1000,
        boardHeight: 1000,
        renderWidth: 0,
        renderHeight: 0,
      }),
    );
    expect(container.querySelector('svg')).toBeNull();
  });
});
