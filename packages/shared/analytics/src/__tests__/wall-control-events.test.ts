import { describe, it, expect } from 'vitest';
import { wallControlPreviewReason, type WallControlPreviewReasonInput } from '../wall-control-events';
import * as analytics from '../index';

describe('wallControlPreviewReason', () => {
  const solo: WallControlPreviewReasonInput = { isPreview: true, otherBoard: false, inSession: false };

  it.each([
    ['a solo preview, the 2.7 default', solo, 'default'],
    ['a crew browse', { ...solo, inSession: true }, 'session'],
    ['a climb on another board', { ...solo, otherBoard: true }, 'other_board'],
    // The wall can't light it whoever is here, so the board says why.
    ['a crew browse of a climb on another board', { ...solo, inSession: true, otherBoard: true }, 'other_board'],
    ['the committed climb', { ...solo, isPreview: false }, null],
    ['the committed climb on another board, in a crew', { isPreview: false, otherBoard: true, inSession: true }, null],
  ] as const)('%s → %s', (_label, input, expected) => {
    expect(wallControlPreviewReason(input)).toBe(expected);
  });

  it('is exported from the package index', () => {
    expect(analytics.wallControlPreviewReason).toBe(wallControlPreviewReason);
  });
});
