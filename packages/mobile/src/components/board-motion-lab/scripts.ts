/**
 * The scripted swipes the lab plays through the real swipe, identical for
 * every variant. Times are clock milliseconds at 1x; the lab's speed stretches
 * them. Translation is in board points and negative is left, toward the next
 * climb, as the carousel's pan reads it. A release commits past
 * `SWIPE_THRESHOLD` (80 pt) of travel, or as a flick from 16 pt at 800 pt/s
 * (`carouselCommitDirection`).
 */
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import type { FingerBeat, FingerScript } from './types';

/** After the last release: the fling has landed and the 200 ms swap has finished. */
export const SCRIPT_SETTLE_MS = 400;

/** The pause before the showcase's first swipe and between its parts. */
export const SHOWCASE_REST_MS = 700;

const NEXT = -1;
const PREVIOUS = 1;

/** `beats` moved `byMs` later. */
function shifted(beats: readonly FingerBeat[], byMs: number): FingerBeat[] {
  return beats.map((beat) => ({ ...beat, atMs: beat.atMs + byMs }));
}

function lastBeatMs(beats: readonly FingerBeat[]): number {
  return beats.reduce((latest, beat) => Math.max(latest, beat.atMs), 0);
}

/** A script: its strokes, then a wait for the last swipe to finish. */
function script(id: string, label: string, strokes: readonly FingerBeat[]): FingerScript {
  return { id, label, beats: [...strokes, { kind: 'wait', atMs: lastBeatMs(strokes) + SCRIPT_SETTLE_MS }] };
}

/**
 * A flick that way from `atMs`: 120 ms long, slow for its first 12 pt, then 63
 * pt in 50 ms, let go at 1,500 pt/s. Its 75 pt is short of the threshold, so it
 * commits as a flick, before the drag has dimmed the holds all the way.
 */
function flick(atMs: number, side: number): FingerBeat[] {
  return [
    { kind: 'down', atMs },
    { kind: 'move', atMs: atMs + 70, translationX: side * 12 },
    { kind: 'move', atMs: atMs + 120, translationX: side * 75 },
    { kind: 'up', atMs: atMs + 120, velocityX: side * 1500 },
  ];
}

/** To the threshold in 450 ms (the holds dim to 40%), then 600 ms more past it, let go slowly. */
const SLOW_DRAG_THEN_COMMIT = script('slow-drag-commit', 'Slow drag, then commit', [
  { kind: 'down', atMs: 0 },
  { kind: 'move', atMs: 450, translationX: NEXT * SWIPE_THRESHOLD },
  { kind: 'move', atMs: 1050, translationX: NEXT * (SWIPE_THRESHOLD + 50) },
  { kind: 'up', atMs: 1100, velocityX: NEXT * 150 },
]);

const QUICK_FLICK = script('quick-flick', 'Quick flick', flick(0, NEXT));

/** To 60% of the threshold, held, let go still: springs back. */
const DRAG_THEN_CANCEL = script('drag-cancel', 'Drag, then cancel', [
  { kind: 'down', atMs: 0 },
  { kind: 'move', atMs: 400, translationX: NEXT * SWIPE_THRESHOLD * 0.6 },
  { kind: 'up', atMs: 700, velocityX: 0 },
]);

/**
 * #7750: a second flick that touches down 80 ms after the first commits, taking over
 * its fling, and commits 140 ms into the first swap.
 */
const FLICK_AGAIN_MID_SWAP = script('flick-again-mid-swap', 'Flick again mid-swap', [
  ...flick(0, NEXT),
  { kind: 'down', atMs: 200 },
  { kind: 'move', atMs: 230, translationX: NEXT * 10 },
  { kind: 'move', atMs: 260, translationX: NEXT * 60 },
  { kind: 'up', atMs: 260, velocityX: NEXT * 1500 },
]);

/** Right, past the threshold at an easy pace. */
const PREVIOUS_CLIMB = script('previous', 'Previous', [
  { kind: 'down', atMs: 0 },
  { kind: 'move', atMs: 300, translationX: PREVIOUS * (SWIPE_THRESHOLD + 30) },
  { kind: 'up', atMs: 340, velocityX: PREVIOUS * 400 },
]);

/** Three flicks 250 ms apart, each committing while the last swap runs. */
const THREE_QUICK_FLICKS = script('three-quick-flicks', 'Three quick flicks', [
  ...flick(0, NEXT),
  ...flick(250, NEXT),
  ...flick(500, NEXT),
]);

/** Every scripted swipe, in the order the controls list them. */
export const FINGER_SCRIPTS: readonly FingerScript[] = [
  SLOW_DRAG_THEN_COMMIT,
  QUICK_FLICK,
  DRAG_THEN_CANCEL,
  FLICK_AGAIN_MID_SWAP,
  PREVIOUS_CLIMB,
  THREE_QUICK_FLICKS,
];

/** Every script in turn, each after a rest: about 10 s at 1x. */
function showcase(scripts: readonly FingerScript[]): FingerScript {
  const beats: FingerBeat[] = [];
  let startMs = SHOWCASE_REST_MS;
  for (const part of scripts) {
    beats.push(...shifted(part.beats, startMs));
    startMs += lastBeatMs(part.beats) + SHOWCASE_REST_MS;
  }
  return { id: 'showcase', label: 'Showcase', beats };
}

/** The run "Play all" gives each variant. */
export const SHOWCASE_SCRIPT: FingerScript = showcase(FINGER_SCRIPTS);
