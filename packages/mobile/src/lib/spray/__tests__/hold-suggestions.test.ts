import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canSuggestSprayHolds,
  registerSprayHoldDetector,
  scaleCandidatesToStoredPhoto,
  suggestSprayHolds,
} from '../hold-suggestions';

const PHOTO = { uri: 'file:///wall.jpg', width: 1000, height: 500 };

afterEach(() => {
  registerSprayHoldDetector(null);
});

describe('scaleCandidatesToStoredPhoto', () => {
  const candidate = { cx: 100, cy: 50, r: 10, confidence: 0.9 };

  it('leaves candidates alone when the two photos are the same size', () => {
    const candidates = [candidate];
    expect(scaleCandidatesToStoredPhoto(candidates, { width: 100, height: 100 }, { width: 100, height: 100 })).toBe(
      candidates,
    );
  });

  it('maps a candidate onto a larger stored photo', () => {
    const [scaled] = scaleCandidatesToStoredPhoto(
      [candidate],
      { width: 1000, height: 500 },
      { width: 2000, height: 1000 },
    );
    expect(scaled).toMatchObject({ cx: 200, cy: 100, r: 20, confidence: 0.9 });
  });

  it('uses the mean of both axes for the radius when the aspect ratio moved', () => {
    const [scaled] = scaleCandidatesToStoredPhoto(
      [candidate],
      { width: 1000, height: 500 },
      { width: 2000, height: 500 },
    );
    // x doubles, y holds: a circle cannot honour both, so the radius takes 1.5x
    // rather than being wrong by the full factor in one direction.
    expect(scaled.r).toBe(15);
  });

  it('refuses to divide by a photo with no size', () => {
    const candidates = [candidate];
    expect(scaleCandidatesToStoredPhoto(candidates, { width: 0, height: 0 }, { width: 100, height: 100 })).toBe(
      candidates,
    );
  });
});

describe('suggestSprayHolds', () => {
  it('answers unavailable when no detector is registered — the manual path', async () => {
    const result = await suggestSprayHolds({ photo: PHOTO, storedPhoto: { width: 1000, height: 500 } });
    expect(result).toEqual({ outcome: 'unavailable' });
    expect(canSuggestSprayHolds()).toBe(false);
  });

  it('answers unavailable when the detector declines (no weights, no network)', async () => {
    registerSprayHoldDetector(async () => null);
    const result = await suggestSprayHolds({ photo: PHOTO, storedPhoto: { width: 1000, height: 500 } });
    expect(result).toEqual({ outcome: 'unavailable' });
  });

  it('answers failed — never throws — when the detector blows up', async () => {
    registerSprayHoldDetector(async () => {
      throw new Error('the session would not open');
    });
    const result = await suggestSprayHolds({ photo: PHOTO, storedPhoto: { width: 1000, height: 500 } });
    expect(result).toEqual({ outcome: 'failed' });
  });

  it('hands candidates back in the STORED photo pixels', async () => {
    registerSprayHoldDetector(async () => [{ cx: 10, cy: 20, r: 4, confidence: 0.7 }]);
    const result = await suggestSprayHolds({ photo: PHOTO, storedPhoto: { width: 2000, height: 1000 } });
    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.candidates[0]).toMatchObject({ cx: 20, cy: 40, r: 8 });
  });

  it('passes the progress callback through so the screen can draw a bar', async () => {
    const onProgress = vi.fn();
    registerSprayHoldDetector(async (request) => {
      request.onProgress?.(1, 4);
      return [];
    });
    await suggestSprayHolds({ photo: PHOTO, storedPhoto: { width: 1000, height: 500 }, onProgress });
    expect(onProgress).toHaveBeenCalledWith(1, 4);
  });

  it('reports a detector once one is registered', () => {
    registerSprayHoldDetector(async () => []);
    expect(canSuggestSprayHolds()).toBe(true);
  });
});
