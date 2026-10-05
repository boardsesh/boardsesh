import { describe, expect, it } from 'vitest';
import { classifySprayDraft, type SprayVersionPhoto } from '../draft-purpose';

const published: SprayVersionPhoto = {
  photoIdentity: 'spray-walls/wall/photo.jpg',
  width: 1200,
  height: 900,
  anchors: [
    [0, 0],
    [1200, 0],
    [1200, 900],
    [0, 900],
  ],
  homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};

describe('spray draft purpose', () => {
  it('allows the initial setup editor without a published source', () => {
    expect(classifySprayDraft(published, null)).toBe('initial');
  });

  it('recognises only the exact reused photo and mapping as hold editing', () => {
    expect(classifySprayDraft(structuredClone(published), published)).toBe('hold-edit');
    expect(classifySprayDraft({ ...published, anchors: null }, { ...published, anchors: null })).toBe('hold-edit');
    expect(classifySprayDraft({ ...published, homography: null }, { ...published, homography: null })).toBe(
      'hold-edit',
    );
  });

  it.each([
    { photoIdentity: 'spray-walls/wall/new.jpg' },
    { photoIdentity: null },
    { width: 600 },
    { height: 450 },
    {
      anchors: [
        [0, 0],
        [600, 0],
        [600, 450],
        [0, 450],
      ],
    },
    { homography: [2, 0, 0, 0, 2, 0, 0, 0, 1] },
    { homography: { unknown: true } },
    { homography: [NaN] },
  ])('requires reset review for mismatched or unavailable geometry: %j', (changed) => {
    expect(classifySprayDraft({ ...published, ...changed }, published)).toBe('reset');
  });
});
