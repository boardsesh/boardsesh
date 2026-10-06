import { describe, expect, it } from 'vitest';
import type { SprayWallArt } from '@boardsesh/graphql/generated/graphql';
import {
  backgroundPickerNote,
  canPickBackground,
  sprayBackgroundGate,
  suggestedBackground,
} from '../spray-background-gate';

function art(
  verdict: 'GOOD' | 'SOFT' | 'FAIL',
  status: SprayWallArt['status'] = 'NONE',
  reason = verdict === 'FAIL' ? 'keystone' : 'ok',
): SprayWallArt {
  return {
    versionNumber: 1,
    recipe: 1,
    status,
    quality: { stretch: 1.5, verdict, reason, frameShortEdge: 2000 },
  };
}

describe('sprayBackgroundGate', () => {
  it.each([
    ['still asking', { status: 'pending' as const, art: undefined }, { kind: 'loading' }],
    ['a backend without the query', { status: 'error' as const, art: undefined }, { kind: 'unsupported' }],
    ['a wall the server will not describe', { status: 'success' as const, art: null }, { kind: 'unsupported' }],
    [
      'no corner pins',
      { status: 'success' as const, art: art('FAIL', 'NONE', 'no-pins') },
      { kind: 'locked', reason: 'no-pins' },
    ],
    ['a keystoned photo', { status: 'success' as const, art: art('FAIL') }, { kind: 'locked', reason: 'retake' }],
    [
      'a frame too small',
      { status: 'success' as const, art: art('FAIL', 'NONE', 'small-frame') },
      { kind: 'locked', reason: 'retake' },
    ],
    [
      'a refused job',
      { status: 'success' as const, art: art('GOOD', 'REFUSED') },
      { kind: 'locked', reason: 'retake' },
    ],
    ['a good draft', { status: 'success' as const, art: art('GOOD') }, { kind: 'open', soft: false, status: 'none' }],
    [
      'a soft photo, rendering',
      { status: 'success' as const, art: art('SOFT', 'PENDING') },
      { kind: 'open', soft: true, status: 'pending' },
    ],
    [
      'ready art',
      { status: 'success' as const, art: art('GOOD', 'READY') },
      { kind: 'open', soft: false, status: 'ready' },
    ],
    [
      'a failed job',
      { status: 'success' as const, art: art('GOOD', 'FAILED') },
      { kind: 'open', soft: false, status: 'failed' },
    ],
  ])('%s', (_label, input, expected) => {
    expect(sprayBackgroundGate(input)).toEqual(expected);
  });

  it('always lets the photo be picked, and the generated looks only when open', () => {
    const locked = sprayBackgroundGate({ status: 'success', art: art('FAIL') });
    const open = sprayBackgroundGate({ status: 'success', art: art('GOOD') });
    expect(canPickBackground(locked, 'photo')).toBe(true);
    expect(canPickBackground(locked, 'wall-crop')).toBe(false);
    expect(canPickBackground(locked, 'hold-cutouts')).toBe(false);
    expect(canPickBackground(open, 'hold-cutouts')).toBe(true);
  });

  it('suggests Wall only when the gate passes, and never Holds only', () => {
    expect(suggestedBackground(sprayBackgroundGate({ status: 'success', art: art('GOOD') }))).toBe('wall-crop');
    expect(suggestedBackground(sprayBackgroundGate({ status: 'success', art: art('SOFT') }))).toBe('wall-crop');
    expect(suggestedBackground(sprayBackgroundGate({ status: 'success', art: art('FAIL') }))).toBe('photo');
    expect(suggestedBackground(sprayBackgroundGate({ status: 'error', art: undefined }))).toBe('photo');
  });
});

describe('backgroundPickerNote', () => {
  const open = (status: 'none' | 'pending' | 'ready' | 'failed', soft = false) =>
    ({ kind: 'open', soft, status }) as const;
  it.each([
    [{ kind: 'locked', reason: 'no-pins' } as const, 'photo', false, 'lockedNoPins'],
    [{ kind: 'locked', reason: 'retake' } as const, 'photo', false, 'lockedRetake'],
    [open('ready'), 'photo', false, null],
    [open('none'), 'wall-crop', true, 'afterPublish'],
    [open('pending'), 'wall-crop', false, 'generating'],
    [open('none'), 'wall-crop', false, 'generating'],
    [open('failed'), 'hold-cutouts', false, 'failed'],
    [open('ready', true), 'wall-crop', false, 'soft'],
    [open('ready'), 'hold-cutouts', false, 'volumes'],
    [open('ready'), 'wall-crop', false, null],
  ] as const)('%o + %s (draft %s) -> %s', (gate, value, isDraft, expected) => {
    expect(backgroundPickerNote(gate, value, isDraft)).toBe(expected);
  });
});
