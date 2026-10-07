import { describe, expect, it } from 'vitest';
import {
  FULL_RECT,
  IDENTITY_EDIT,
  MIN_CROP_FRACTION,
  ORIGINAL_RENDER_MAX_PIXELS,
  cropToPixels,
  editCrops,
  editRotates,
  editsEqual,
  enforceMinimumCrop,
  isIdentityEdit,
  isPhotoSmall,
  minimumCropFractions,
  orientedOriginalSize,
  planWallPhotoRender,
  predictedEditOutput,
  renderableOriginalSize,
  rotateEditClockwise,
  rotatedSize,
  type WallPhotoEdit,
} from '../photo-edit';

/** A 12 MP photo: under the cap, so the base keeps its size. */
const LANDSCAPE = { width: 4032, height: 3024 };
const PORTRAIT = { width: 3024, height: 4032 };
/** A 24 MP capture (5712 x 4284) and the base the compressor shrinks it to. */
const LANDSCAPE_24MP = { width: 5712, height: 4284 };
const PORTRAIT_24MP = { width: 4284, height: 5712 };
const BASE_4096 = { width: 4096, height: 3072 };

/**
 * A long-side ceiling for the plans below. Under the shared cap's square limit
 * (4946 px), so these read as the long-side rule alone; the pixel cap has its
 * own tests at the real 5712.
 */
const MAX = 4096;
/** `WALL_PHOTO_MAX_DIMENSION` / `SPRAY_WALL_PHOTO_MAX_LONG_SIDE`. */
const UPLOAD_MAX = 5712;

/** A crop off-centre enough that every edge is distinguishable. */
const SKEWED_CROP = { left: 0.1, top: 0.2, right: 0.7, bottom: 0.9 };

describe('rotateEditClockwise', () => {
  it('comes back to where it started after four quarter turns', () => {
    let edit: WallPhotoEdit = { quarterTurns: 0, crop: SKEWED_CROP };
    for (let turn = 0; turn < 4; turn++) edit = rotateEditClockwise(edit);
    expect(edit.quarterTurns).toBe(0);
    expect(edit.crop.left).toBeCloseTo(SKEWED_CROP.left, 12);
    expect(edit.crop.top).toBeCloseTo(SKEWED_CROP.top, 12);
    expect(edit.crop.right).toBeCloseTo(SKEWED_CROP.right, 12);
    expect(edit.crop.bottom).toBeCloseTo(SKEWED_CROP.bottom, 12);
  });

  it('carries the crop with the picture: the old left edge becomes the top', () => {
    // A point at (x, y) lands at (1 - y, x) a quarter turn clockwise.
    expect(rotateEditClockwise({ quarterTurns: 0, crop: SKEWED_CROP })).toEqual({
      quarterTurns: 1,
      crop: { left: 1 - 0.9, top: 0.1, right: 1 - 0.2, bottom: 0.7 },
    });
  });

  it('keeps the whole photo whole', () => {
    expect(rotateEditClockwise(IDENTITY_EDIT)).toEqual({ quarterTurns: 1, crop: FULL_RECT });
  });
});

describe('rotatedSize', () => {
  it('swaps the sides on an odd number of turns only', () => {
    expect(rotatedSize(LANDSCAPE, 0)).toEqual(LANDSCAPE);
    expect(rotatedSize(LANDSCAPE, 1)).toEqual(PORTRAIT);
    expect(rotatedSize(LANDSCAPE, 2)).toEqual(LANDSCAPE);
    expect(rotatedSize(LANDSCAPE, 3)).toEqual(PORTRAIT);
  });
});

describe('cropToPixels', () => {
  it('answers whole pixels', () => {
    const crop = cropToPixels({ left: 0.333, top: 0.1234, right: 0.6667, bottom: 0.987 }, { width: 1001, height: 777 });
    for (const value of Object.values(crop)) expect(Number.isInteger(value)).toBe(true);
  });

  it('never reaches past the image, even from fractions out of range', () => {
    const crop = cropToPixels({ left: -0.2, top: -1, right: 1.4, bottom: 2 }, BASE_4096);
    expect(crop).toEqual({ originX: 0, originY: 0, width: 4096, height: 3072 });
  });

  it('keeps at least one pixel when the rectangle has collapsed', () => {
    const crop = cropToPixels({ left: 1, top: 1, right: 1, bottom: 1 }, { width: 100, height: 50 });
    expect(crop.width).toBeGreaterThanOrEqual(1);
    expect(crop.height).toBeGreaterThanOrEqual(1);
    expect(crop.originX + crop.width).toBeLessThanOrEqual(100);
    expect(crop.originY + crop.height).toBeLessThanOrEqual(50);
  });
});

describe('orientedOriginalSize', () => {
  it('takes the aspect from the base and the long side from the picker', () => {
    // A portrait base from an Android picker that reported the sensor's
    // landscape numbers: the base is the truth about which way up it is.
    expect(orientedOriginalSize({ width: 3072, height: 4096 }, 5712)).toEqual({ width: 4283, height: 5712 });
    expect(orientedOriginalSize(BASE_4096, 5712)).toEqual({ width: 5712, height: 4283 });
  });

  it('never overshoots the real short side', () => {
    // The base's short side was rounded from the original's; the derived one
    // must be a lower bound or Android's cropper throws at the far edge.
    for (let trueShort = 4260; trueShort <= 4300; trueShort++) {
      const baseShort = Math.round((trueShort * MAX) / 5712);
      const derived = orientedOriginalSize({ width: MAX, height: baseShort }, 5712);
      expect(derived?.height, `true short side ${trueShort}`).toBeLessThanOrEqual(trueShort);
    }
  });

  it('is the base itself when the compressor left the photo alone', () => {
    expect(orientedOriginalSize({ width: 1600, height: 1200 }, 1600)).toEqual({ width: 1600, height: 1200 });
    // A 12 MP photo is under the cap, so it is one of these too.
    expect(orientedOriginalSize(LANDSCAPE, 4032)).toEqual(LANDSCAPE);
  });

  it('answers null for sizes it cannot trust', () => {
    expect(orientedOriginalSize({ width: 0, height: 0 }, 4032)).toBeNull();
    expect(orientedOriginalSize(BASE_4096, 0)).toBeNull();
    expect(orientedOriginalSize(BASE_4096, Number.NaN)).toBeNull();
    // An "original" smaller than its own compressed copy.
    expect(orientedOriginalSize(BASE_4096, 1000)).toBeNull();
  });
});

describe('renderableOriginalSize', () => {
  it('reads the 12 MP and 24 MP originals phones take by default', () => {
    expect(renderableOriginalSize(LANDSCAPE, 4032)).toEqual(LANDSCAPE);
    expect(renderableOriginalSize(BASE_4096, 5712)).toEqual({ width: 5712, height: 4283 });
  });

  it('reads the base instead of a 48 MP original, which is about 195 MB decoded', () => {
    expect(8064 * 6048).toBeGreaterThan(ORIGINAL_RENDER_MAX_PIXELS);
    expect(renderableOriginalSize(BASE_4096, 8064)).toBeNull();
    expect(renderableOriginalSize({ width: 3072, height: 4096 }, 8064)).toBeNull();
  });

  it('reads the base when the original size is unknown', () => {
    expect(renderableOriginalSize(BASE_4096, 0)).toBeNull();
  });
});

describe('planWallPhotoRender', () => {
  it('plans nothing for the identity edit on a photo already small enough', () => {
    expect(planWallPhotoRender(IDENTITY_EDIT, LANDSCAPE, MAX)).toEqual({ ops: [], output: LANDSCAPE });
  });

  it('only shrinks for the identity edit on a big photo', () => {
    expect(planWallPhotoRender(IDENTITY_EDIT, LANDSCAPE_24MP, MAX)).toEqual({
      ops: [{ type: 'resize', width: MAX }],
      output: BASE_4096,
    });
  });

  it('rotates, then crops, then resizes, in that order', () => {
    const plan = planWallPhotoRender(
      { quarterTurns: 1, crop: { left: 0, top: 0, right: 1, bottom: 0.9 } },
      LANDSCAPE_24MP,
      MAX,
    );
    expect(plan.ops.map((op) => op.type)).toEqual(['rotate', 'crop', 'resize']);
    expect(plan.ops[0]).toEqual({ type: 'rotate', degrees: 90 });
    // The crop is measured on the ROTATED (portrait) image.
    expect(plan.ops[1]).toEqual({ type: 'crop', rect: { originX: 0, originY: 0, width: 4284, height: 5141 } });
    expect(plan.ops[2]).toEqual({ type: 'resize', height: MAX });
    expect(plan.output).toEqual({ width: 3413, height: MAX });
  });

  it('never lets the long side past the maximum, whichever way up', () => {
    const sizes = [LANDSCAPE, PORTRAIT, LANDSCAPE_24MP, PORTRAIT_24MP, { width: 8064, height: 6048 }];
    for (const size of [...sizes, { width: 6000, height: 6000 }]) {
      for (const quarterTurns of [0, 1, 2, 3] as const) {
        for (const crop of [SKEWED_CROP, FULL_RECT]) {
          const plan = planWallPhotoRender({ quarterTurns, crop }, size, MAX);
          expect(Math.max(plan.output.width, plan.output.height)).toBeLessThanOrEqual(MAX);
        }
      }
    }
  });

  it('keeps a portrait crop portrait and a landscape crop landscape', () => {
    const portrait = planWallPhotoRender(
      { quarterTurns: 0, crop: { left: 0.4, top: 0, right: 0.6, bottom: 1 } },
      LANDSCAPE_24MP,
      MAX,
    );
    expect(portrait.output.height).toBeGreaterThan(portrait.output.width);
    const landscape = planWallPhotoRender({ quarterTurns: 1, crop: FULL_RECT }, PORTRAIT_24MP, MAX);
    expect(landscape.output).toEqual(BASE_4096);
  });

  it('lets a 24 MP photo through at the real cap', () => {
    expect(planWallPhotoRender({ quarterTurns: 1, crop: FULL_RECT }, LANDSCAPE_24MP, UPLOAD_MAX)).toEqual({
      ops: [{ type: 'rotate', degrees: 90 }],
      output: PORTRAIT_24MP,
    });
  });

  it('shrinks a square crop under the pixel cap, not just the long-side cap', () => {
    // 5712 x 5712 decodes to 130 MB, past the 100 MiB Android will draw.
    const plan = planWallPhotoRender({ quarterTurns: 0, crop: FULL_RECT }, { width: 6000, height: 6000 }, UPLOAD_MAX);
    expect(plan.ops).toEqual([{ type: 'resize', width: 4946 }]);
    expect(plan.output).toEqual({ width: 4946, height: 4946 });
  });

  it('never decodes past 24.5 MP at the real cap, whatever the crop', () => {
    const sizes = [LANDSCAPE_24MP, PORTRAIT_24MP, { width: 8064, height: 6048 }, { width: 6000, height: 6000 }];
    const crops = [FULL_RECT, SKEWED_CROP, { left: 0.1, top: 0, right: 0.85, bottom: 1 }];
    for (const size of sizes) {
      for (const quarterTurns of [0, 1, 2, 3] as const) {
        for (const crop of crops) {
          const { output } = planWallPhotoRender({ quarterTurns, crop }, size, UPLOAD_MAX);
          expect(Math.max(output.width, output.height)).toBeLessThanOrEqual(UPLOAD_MAX);
          // Half a row of rounding at most, and always under Android's 100 MiB.
          expect(output.width * output.height).toBeLessThanOrEqual(5712 * 4284 + 5712 / 2);
          expect(output.width * output.height * 4).toBeLessThan(100 * 1024 * 1024);
        }
      }
    }
  });

  it('does not enlarge a small crop', () => {
    const plan = planWallPhotoRender(
      { quarterTurns: 0, crop: { left: 0, top: 0, right: 0.25, bottom: 0.25 } },
      LANDSCAPE,
      MAX,
    );
    expect(plan.ops.map((op) => op.type)).toEqual(['crop']);
    expect(plan.output).toEqual({ width: 1008, height: 756 });
  });
});

describe('identity and equality', () => {
  it('reads null and the whole photo unturned as no edit', () => {
    expect(isIdentityEdit(null)).toBe(true);
    expect(isIdentityEdit(IDENTITY_EDIT)).toBe(true);
    expect(isIdentityEdit({ quarterTurns: 2, crop: FULL_RECT })).toBe(false);
    expect(isIdentityEdit({ quarterTurns: 0, crop: SKEWED_CROP })).toBe(false);
  });

  it('reports cropping and turning separately', () => {
    expect([editCrops(null), editRotates(null)]).toEqual([false, false]);
    expect([
      editCrops({ quarterTurns: 3, crop: FULL_RECT }),
      editRotates({ quarterTurns: 3, crop: FULL_RECT }),
    ]).toEqual([false, true]);
    expect([
      editCrops({ quarterTurns: 0, crop: SKEWED_CROP }),
      editRotates({ quarterTurns: 0, crop: SKEWED_CROP }),
    ]).toEqual([true, false]);
  });

  it('treats null and the identity as the same edit', () => {
    expect(editsEqual(null, IDENTITY_EDIT)).toBe(true);
    expect(editsEqual({ quarterTurns: 1, crop: SKEWED_CROP }, { quarterTurns: 1, crop: { ...SKEWED_CROP } })).toBe(
      true,
    );
    expect(editsEqual({ quarterTurns: 1, crop: SKEWED_CROP }, { quarterTurns: 2, crop: SKEWED_CROP })).toBe(false);
  });
});

describe('the minimum crop', () => {
  it('is 15% of a long side, and 512 base pixels of a short one', () => {
    // On a 4096 x 3072 base, 15% of the long side (614 px) is more than 512.
    const min = minimumCropFractions(BASE_4096, 0);
    expect(min.width).toBeCloseTo(MIN_CROP_FRACTION, 12);
    expect(min.height).toBeCloseTo(512 / 3072, 12);
  });

  it('follows the sides through a quarter turn', () => {
    const min = minimumCropFractions(BASE_4096, 1);
    expect(min.width).toBeCloseTo(512 / 3072, 12);
    expect(min.height).toBeCloseTo(MIN_CROP_FRACTION, 12);
  });

  it('is 512 px on both sides of a base too small for 15% to reach it', () => {
    const min = minimumCropFractions({ width: 1600, height: 1200 }, 0);
    expect(min.width).toBeCloseTo(512 / 1600, 12);
    expect(min.height).toBeCloseTo(512 / 1200, 12);
  });

  it('is the whole side when the side has nothing to spare', () => {
    expect(minimumCropFractions({ width: 400, height: 300 }, 0)).toEqual({ width: 1, height: 1 });
  });

  it('grows a crop that a turn left too thin, about its own centre and inside the photo', () => {
    const grown = enforceMinimumCrop({ left: 0.9, top: 0.4, right: 1, bottom: 0.6 }, { width: 0.3, height: 0.3 });
    expect(grown.right - grown.left).toBeCloseTo(0.3, 12);
    expect(grown.bottom - grown.top).toBeCloseTo(0.3, 12);
    expect(grown.right).toBeLessThanOrEqual(1);
    expect(grown.left).toBeCloseTo(0.7, 12);
    expect((grown.top + grown.bottom) / 2).toBeCloseTo(0.5, 12);
  });
});

describe('the small-photo hint', () => {
  it('warns under 1200 px on the long side, and only then', () => {
    expect(isPhotoSmall({ width: 1100, height: 800 })).toBe(true);
    expect(isPhotoSmall({ width: 1200, height: 900 })).toBe(false);
    expect(isPhotoSmall({ width: 0, height: 0 })).toBe(false);
  });

  const QUARTER_CROP: WallPhotoEdit = { quarterTurns: 0, crop: { left: 0, top: 0, right: 0.25, bottom: 0.25 } };

  it('predicts the output from the original, not the preview', () => {
    // A quarter of each side of a 24 MP photo keeps 1428 x 1071 of the
    // original, where the 4096 px base would have kept only 1024 x 768.
    const output = predictedEditOutput(QUARTER_CROP, BASE_4096, 5712, MAX);
    expect(output).toEqual({ width: 1428, height: 1071 });
    expect(isPhotoSmall(output)).toBe(false);
  });

  it('predicts from the base when the render will read the base', () => {
    // A 48 MP original is too big to decode, so the upload is cut from the
    // 4096 px base. Planning from the original would promise 2016 px and
    // hide the hint.
    const output = predictedEditOutput(QUARTER_CROP, BASE_4096, 8064, MAX);
    expect(output).toEqual({ width: 1024, height: 768 });
    expect(isPhotoSmall(output)).toBe(true);
  });
});
