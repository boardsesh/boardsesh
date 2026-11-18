import { describe, expect, it } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import { carouselCommitDirection } from '../../play-drawer/carousel-commit';
import { FINGER_SCRIPTS, SCRIPT_SETTLE_MS, SHOWCASE_SCRIPT } from '../scripts';
import type { FingerBeat, FingerScript } from '../types';

type Release = { downAtMs: number; upAtMs: number; travel: number; velocityX: number };

/** Each touch in a script, as the carousel's pan would judge its release. */
function releases(beats: readonly FingerBeat[]): Release[] {
  const found: Release[] = [];
  let downAtMs = 0;
  let travel = 0;
  for (const beat of beats) {
    if (beat.kind === 'down') {
      downAtMs = beat.atMs;
      travel = 0;
    }
    if (beat.kind === 'move') travel = beat.translationX;
    if (beat.kind === 'up') found.push({ downAtMs, upAtMs: beat.atMs, travel, velocityX: beat.velocityX });
  }
  return found;
}

function commits(script: FingerScript) {
  return releases(script.beats).map(({ travel, velocityX }) =>
    carouselCommitDirection(travel, velocityX, SWIPE_THRESHOLD),
  );
}

function byId(id: string): FingerScript {
  const found = FINGER_SCRIPTS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no script ${id}`);
  return found;
}

describe('finger scripts', () => {
  it.each([...FINGER_SCRIPTS, SHOWCASE_SCRIPT])('$label: in time order, every touch let go', (script) => {
    const times = script.beats.map((beat) => beat.atMs);
    expect(times).toEqual([...times].sort((first, second) => first - second));
    const touches = script.beats.filter((beat) => beat.kind === 'down' || beat.kind === 'up').map((beat) => beat.kind);
    expect(touches.length % 2).toBe(0);
    touches.forEach((kind, index) => expect(kind).toBe(index % 2 === 0 ? 'down' : 'up'));
  });

  it('have unique ids and end once the last swipe has finished', () => {
    expect(new Set(FINGER_SCRIPTS.map((script) => script.id)).size).toBe(FINGER_SCRIPTS.length);
    for (const script of FINGER_SCRIPTS) {
      const lastRelease = releases(script.beats).at(-1);
      expect(script.beats.at(-1)).toEqual({ kind: 'wait', atMs: (lastRelease?.upAtMs ?? 0) + SCRIPT_SETTLE_MS });
    }
  });

  it('commit as named: left is the next climb', () => {
    expect(commits(byId('slow-drag-commit'))).toEqual(['next']);
    expect(commits(byId('quick-flick'))).toEqual(['next']);
    expect(commits(byId('drag-cancel'))).toEqual([null]);
    expect(commits(byId('flick-again-mid-swap'))).toEqual(['next', 'next']);
    expect(commits(byId('previous'))).toEqual(['previous']);
    expect(commits(byId('three-quick-flicks'))).toEqual(['next', 'next', 'next']);
  });

  it('slow drag: dims to the threshold, then stays past it about 600 ms, let go slowly', () => {
    const { beats } = byId('slow-drag-commit');
    const atThreshold = beats.find((beat) => beat.kind === 'move' && beat.translationX === -SWIPE_THRESHOLD);
    const [release] = releases(beats);
    expect(atThreshold).toBeDefined();
    expect(release.upAtMs - (atThreshold?.atMs ?? 0)).toBeGreaterThanOrEqual(600);
    expect(Math.abs(release.velocityX)).toBeLessThan(800);
  });

  it('quick flick: about 120 ms, let go at 1,500 pt/s, short of the threshold', () => {
    const [release] = releases(byId('quick-flick').beats);
    expect(release.upAtMs - release.downAtMs).toBe(120);
    expect(release.velocityX).toBe(-1500);
    expect(Math.abs(release.travel)).toBeLessThan(SWIPE_THRESHOLD);
  });

  it('cancel: 60% of the threshold, let go still', () => {
    const [release] = releases(byId('drag-cancel').beats);
    expect(release.travel).toBeCloseTo(-SWIPE_THRESHOLD * 0.6, 10);
    expect(release.velocityX).toBe(0);
  });

  it('flick again mid-swap: the second touch lands 80 ms after the first commit', () => {
    const [first, second] = releases(byId('flick-again-mid-swap').beats);
    expect(second.downAtMs - first.upAtMs).toBe(80);
    // Commits inside the first 200 ms swap.
    expect(second.upAtMs - first.upAtMs).toBeLessThan(200);
  });

  it('the showcase plays every script in order in about 10 s', () => {
    expect(SHOWCASE_SCRIPT.beats.at(-1)?.atMs).toBeGreaterThan(9000);
    expect(SHOWCASE_SCRIPT.beats.at(-1)?.atMs).toBeLessThan(11000);
    expect(SHOWCASE_SCRIPT.beats[0].atMs).toBeGreaterThan(0);
    expect(commits(SHOWCASE_SCRIPT)).toEqual(FINGER_SCRIPTS.flatMap(commits));
  });
});
