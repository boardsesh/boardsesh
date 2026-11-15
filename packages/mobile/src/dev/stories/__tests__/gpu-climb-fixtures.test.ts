import { describe, expect, it } from 'vitest';
import { AURA_GLOW_TUNING, DEFAULT_BOARDSESH_RENDER_SETTINGS } from '@boardsesh/board-look';
import type { BoardArtGeometry } from '@boardsesh/board-art-geometry';
import {
  buildGpuParityConfig,
  buildGpuParityFixtures,
  GPU_PARITY_OUTPUT_WIDTH,
  gpuParityParameters,
  isCurrentGpuParityRequest,
} from '../gpu-climb-fixtures';

const holds = Array.from({ length: 40 }, (_, index) => ({
  id: index + 100,
  mirroredHoldId: null,
  cx: (index % 8) * 60 + 30,
  cy: Math.floor(index / 8) * 70 + 30,
  r: 12,
}));
const geometry: BoardArtGeometry = {
  outlines: { 100: [-1, -1, 1, -1, 1, 1, -1, 1] },
  silhouetteLightness: { 100: 0.6 },
  ledBright: {},
};

describe('GPU parity diagnostic fixtures', () => {
  it('bounds capture deep-link parameters and requires explicit positive flags', () => {
    expect(gpuParityParameters({ gpu: '1', sample: '4', resolution: '1024', mode: 'metal', verify: '1' })).toEqual({
      enabled: true,
      sample: 4,
      resolution: 1024,
      mode: 'metal',
      verify: true,
    });
    expect(
      gpuParityParameters({ gpu: 'true', sample: '99', resolution: '9999', mode: 'unknown', verify: ['1'] }),
    ).toEqual({ enabled: false, sample: 0, resolution: 768, mode: 'compare', verify: false });
  });
  it('uses only real placements, distinct holds, and Homewall roles', () => {
    const fixtures = buildGpuParityFixtures(holds);
    expect(fixtures.map((fixture) => fixture.holdCount)).toEqual([6, 30, 2, 2, 0]);
    for (const fixture of fixtures) {
      const lit = [...fixture.frames.matchAll(/p(\d+)r(\d+)/g)];
      expect(new Set(lit.map((match) => match[1])).size).toBe(fixture.holdCount);
      for (const [, holdId, role] of lit) {
        expect(holds.some((hold) => hold.id === Number(holdId))).toBe(true);
        expect([42, 43, 44, 45]).toContain(Number(role));
      }
    }
  });

  it('uses the same adjacent holds to expose merge and different-colour seam behavior', () => {
    const [, , same, different, empty] = buildGpuParityFixtures(holds);
    expect([...same.frames.matchAll(/p(\d+)/g)].map((match) => match[1])).toEqual(
      [...different.frames.matchAll(/p(\d+)/g)].map((match) => match[1]),
    );
    expect(new Set([...same.frames.matchAll(/r(\d+)/g)].map((match) => match[1])).size).toBe(1);
    expect(new Set([...different.frames.matchAll(/r(\d+)/g)].map((match) => match[1])).size).toBe(2);
    expect(empty.frames).toBe('');
  });

  it('keeps complete geometry and tuning stable between climbs for atlas reuse', () => {
    const inputs = {
      boardWidth: 1080,
      boardHeight: 1500,
      holds,
      geometry,
      wallLightness: null,
      colorScheme: 'light' as const,
    };
    const { frames: firstFrames, ...first } = buildGpuParityConfig({ ...inputs, frames: 'p100r43' });
    const { frames: nextFrames, ...next } = buildGpuParityConfig({ ...inputs, frames: 'p101r44' });
    expect(firstFrames).not.toBe(nextFrames);
    expect(first).toEqual(next);
    expect(next.holds[0].outline).toEqual(geometry.outlines[100]);
    expect(next.output_width).toBe(GPU_PARITY_OUTPUT_WIDTH);
    expect(next.glow).toMatchObject(AURA_GLOW_TUNING);
    expect(next.mark_style).toBe(DEFAULT_BOARDSESH_RENDER_SETTINGS.markStyle);
    expect(next.hold_state_map[43].color).not.toBe('#0000FF');
  });

  it('rejects too-small fixtures instead of reporting duplicated holds as 30', () => {
    expect(() => buildGpuParityFixtures(holds.slice(0, 10))).toThrow('at least 30');
  });

  it('rejects measurements from previous fixtures and previous runs', () => {
    expect(isCurrentGpuParityRequest('dark-30-run2', 'light-6-run1')).toBe(false);
    expect(isCurrentGpuParityRequest('dark-30-run2', 'dark-30-run1')).toBe(false);
    expect(isCurrentGpuParityRequest('dark-30-run2', 'dark-30-run2')).toBe(true);
  });
});
