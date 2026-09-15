// TypeScript post-processing against the Python that produced the shipped
// numbers. The app and `ml/holds/eval.py` have to agree about what the same
// model saw, or SW-01's measured F1 describes a pipeline nobody runs.
//
// The comparison is deliberately NOT "run the model in Node and see". The
// exported int8 ONNX is 28.7 MB against a 15 MB repo ceiling
// (`ml/holds/fixtures/README.md`), so CI has no model — and even with one, the
// image resampling in front of it is Pillow's, not this package's. What is
// pinned here is the half this package owns: decode, un-letterbox, tile merge,
// NMS, candidates, replayed from the model's RECORDED output tensors
// (`fixtures/*.outputs.json`, written by `scripts/capture-fixture-outputs.ts`)
// and compared with `ml/holds/fixtures/expected-detections.json`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { toHoldCandidates } from '../candidates';
import { decodeRfDetr } from '../decode';
import { type LetterboxMapping, unLetterbox } from '../letterbox';
import { mergeTiles } from '../nms';
import { planTiles } from '../tiles';
import type { Detection } from '../types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');

/** `nano-tiled-1024` from ml/holds/configs.json — what the expectations used. */
const CONFIG = { longSide: 1024, rows: 2, cols: 2, overlap: 0.15, size: 384, scoreThreshold: 0.05, nmsIou: 0.5 };

/** The tolerances `ml/holds/fixtures/README.md` names for a float CPU ONNX run. */
const BOX_TOLERANCE_PX = 1;
const SCORE_TOLERANCE = 1e-3;

interface CapturedOutputs {
  fileName: string;
  width: number;
  height: number;
  scale: number;
  workingWidth: number;
  workingHeight: number;
  tiles: {
    window: [number, number, number, number];
    boxes: number[];
    boxesShape: number[];
    logits: number[];
    logitsShape: number[];
  }[];
}

interface ExpectedDetections {
  scoreThreshold: number;
  nmsIou: number;
  resolution: number;
  longSide: number;
  tiles: { rows: number; cols: number; overlap: number };
  images: { file_name: string; width: number; height: number; detections: { box: number[]; score: number }[] }[];
}

const expected = JSON.parse(
  readFileSync(join(REPO_ROOT, 'ml', 'holds', 'fixtures', 'expected-detections.json'), 'utf8'),
) as ExpectedDetections;

function captured(fileName: string): CapturedOutputs {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', `${fileName}.outputs.json`), 'utf8')) as CapturedOutputs;
}

/** Replay one photo's recorded tensors through the whole post-processing chain. */
function replay(outputs: CapturedOutputs): Detection[] {
  const plan = planTiles(outputs.width, outputs.height, CONFIG);
  const perTile = plan.tiles.map((rect, tileIndex) => {
    const tile = outputs.tiles[tileIndex];
    const mapping: LetterboxMapping = {
      rect,
      size: CONFIG.size,
      fit: 'stretch',
      content: { x: 0, y: 0, width: CONFIG.size, height: CONFIG.size },
    };
    return decodeRfDetr(tile, { scoreThreshold: CONFIG.scoreThreshold, tileIndex }).map((detection) => ({
      ...detection,
      box: unLetterbox(detection.box, mapping),
    }));
  });
  return mergeTiles(perTile, { iouThreshold: CONFIG.nmsIou });
}

describe('parity with ml/holds/eval.py', () => {
  it('reads the expectations the committed config produced', () => {
    // If the fixture is ever regenerated under a different config, every
    // comparison below is silently against the wrong pipeline.
    expect(expected.resolution).toBe(CONFIG.size);
    expect(expected.longSide).toBe(CONFIG.longSide);
    expect(expected.tiles).toEqual({ rows: CONFIG.rows, cols: CONFIG.cols, overlap: CONFIG.overlap });
    expect(expected.scoreThreshold).toBe(CONFIG.scoreThreshold);
    expect(expected.nmsIou).toBe(CONFIG.nmsIou);
    expect(expected.images).toHaveLength(3);
  });

  for (const image of expected.images) {
    describe(image.file_name, () => {
      const outputs = captured(image.file_name);

      it('plans the same tiles Python cropped', () => {
        // `planTiles` expresses the windows in photo pixels; the capture recorded
        // them in the long-side working frame, so the check is the round trip.
        const plan = planTiles(outputs.width, outputs.height, CONFIG);
        expect(plan.workingWidth).toBe(outputs.workingWidth);
        expect(plan.workingHeight).toBe(outputs.workingHeight);
        expect(plan.tiles).toHaveLength(outputs.tiles.length);
        plan.tiles.forEach((rect, index) => {
          const [x0, y0, x1, y1] = outputs.tiles[index].window;
          expect(rect.x0 * plan.scale).toBeCloseTo(x0, 6);
          expect(rect.y0 * plan.scale).toBeCloseTo(y0, 6);
          expect(rect.x1 * plan.scale).toBeCloseTo(x1, 6);
          expect(rect.y1 * plan.scale).toBeCloseTo(y1, 6);
        });
      });

      it('decodes, merges and un-letterboxes to the same detections', () => {
        const detections = replay(outputs);
        expect(detections).toHaveLength(image.detections.length);

        detections.forEach((detection, index) => {
          const reference = image.detections[index];
          expect(detection.score).toBeCloseTo(reference.score, 3);
          expect(Math.abs(detection.score - reference.score)).toBeLessThanOrEqual(SCORE_TOLERANCE);
          detection.box.forEach((value, axis) => {
            expect(Math.abs(value - reference.box[axis])).toBeLessThanOrEqual(BOX_TOLERANCE_PX);
          });
        });
      });

      it('turns those detections into circles that cover the same boxes', () => {
        const candidates = toHoldCandidates(replay(outputs));
        expect(candidates).toHaveLength(image.detections.length);
        candidates.forEach((candidate, index) => {
          const [x0, y0, x1, y1] = image.detections[index].box;
          expect(Math.abs(candidate.cx - (x0 + x1) / 2)).toBeLessThanOrEqual(BOX_TOLERANCE_PX);
          expect(Math.abs(candidate.cy - (y0 + y1) / 2)).toBeLessThanOrEqual(BOX_TOLERANCE_PX);
          // Equal-area radius: pi r^2 == w * h. Compared as a radius rather than
          // an area because the committed boxes are rounded to two decimals, and
          // half a square pixel of rounding on a 100,000 px^2 box is not a
          // disagreement about anything.
          expect(Math.abs(candidate.r - Math.sqrt(((x1 - x0) * (y1 - y0)) / Math.PI))).toBeLessThanOrEqual(
            BOX_TOLERANCE_PX,
          );
          // The detector only ever hands back what cleared the threshold.
          expect(candidate.score).toBeGreaterThanOrEqual(CONFIG.scoreThreshold);
          // No outline: the model returns boxes, not masks. See candidates.ts.
          expect(candidate.outline).toBeUndefined();
        });
      });
    });
  }
});
