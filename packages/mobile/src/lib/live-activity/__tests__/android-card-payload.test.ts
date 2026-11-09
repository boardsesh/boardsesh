import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { V_GRADE_COLORS } from '@boardsesh/board-constants/grade-colors';
import { BOKEH_DARK_SURFACE, bokehPixel, type BokehBlob } from '@boardsesh/frosted-bokeh';
import { contrast } from '../../../components/play-drawer/wall-glow';
import { buildAndroidCardPayload, readableGradeColor } from '../android-card-payload';

const glow = {
  key: 'climb',
  boardWidth: 100,
  boardHeight: 200,
  holds: [
    { x: 20, y: 180, color: '#00FF00' },
    { x: 50, y: 100, color: '#00FFFF' },
    { x: 80, y: 20, color: '#FF00FF' },
  ],
};

function payload(overrides: Partial<Parameters<typeof buildAndroidCardPayload>[0]> = {}) {
  return buildAndroidCardPayload({ glow, difficulty: '6c/V5', boardName: 'kilter', angle: 40, ...overrides });
}

describe('buildAndroidCardPayload', () => {
  it('puts the expanded holds in the band behind the controls', () => {
    const { expanded } = payload();

    expect(expanded).toHaveLength(3);
    for (const blob of expanded) {
      expect(blob.y).toBeGreaterThanOrEqual(84);
      expect(blob.y).toBeLessThanOrEqual(140);
    }
  });

  it('reads a climb left to right, start to finish', () => {
    const xs = payload().collapsed.map((blob) => blob.x);

    expect(xs[0]).toBeLessThan(xs[1] ?? 0);
    expect(xs[1]).toBeLessThan(xs[2] ?? 0);
  });

  it('bounds the payload for a long circuit', () => {
    const holds = Array.from({ length: 60 }, (_, index) => ({ x: index, y: index * 2, color: '#00FF00' }));
    const { expanded, collapsed } = payload({ glow: { ...glow, holds } });

    expect(expanded.length).toBeLessThanOrEqual(15);
    expect(collapsed.length).toBeLessThanOrEqual(15);
  });

  it('sends empty lists while the board geometry is missing, keeping the grade', () => {
    const result = payload({ glow: null });

    expect(result.expanded).toEqual([]);
    expect(result.collapsed).toEqual([]);
    expect(result.gradeLabel).toBe('V5');
  });

  it('shows the V-grade alone and keeps a real plus', () => {
    expect(payload({ difficulty: '5b/V1' }).gradeLabel).toBe('V1');
    expect(payload({ difficulty: '6c+/V5' }).gradeLabel).toBe('V5+');
  });

  it('has no grade colour for a climb with no grade', () => {
    const result = payload({ difficulty: null });

    expect(result.gradeLabel).toBeNull();
    expect(result.gradeColor).toBeNull();
  });

  it('labels the angle, and reads the -1 sentinel as no angle', () => {
    expect(payload({ angle: 40 }).angleLabel).toBe('40°');
    expect(payload({ angle: 0 }).angleLabel).toBe('0°');
    expect(payload({ angle: -5 }).angleLabel).toBe('-5°');
    expect(payload({ angle: -1 }).angleLabel).toBeNull();
  });
});

describe('readableGradeColor', () => {
  // The brightest thing that can land under the grade: white holds on both panels.
  const bright: BokehBlob[] = [
    { x: 319, y: 26, r: 46, peak: 0.95, color: '#FFFFFF' },
    { x: 150, y: 24, r: 46, peak: 0.95, color: '#FFFFFF' },
  ];

  it.each(Object.entries(V_GRADE_COLORS))('keeps %s at 4.5:1 over the brightest glow', (_grade, color) => {
    const lifted = readableGradeColor(color, bright, bright);

    for (const point of [
      { x: 319, y: 26 },
      { x: 150, y: 24 },
    ]) {
      const pixel = bokehPixel(point, bright, { surface: BOKEH_DARK_SURFACE, blend: 'screen', fade: 0.8 });
      expect(contrast(lifted, pixel)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('leaves a colour that already passes alone', () => {
    expect(readableGradeColor('#FF7043', [], [])).toBe('#FF7043');
  });

  it('keeps the collapsed line at 4.5:1 over the brightest hold under it', () => {
    const colors = readFileSync(
      new URL('../../../../modules/live-activity/android/src/main/res/values/colors.xml', import.meta.url),
      'utf8',
    );
    const ink = /name="session_card_meta_collapsed">(#[0-9A-Fa-f]{6})</.exec(colors)?.[1] ?? '';
    const pixel = bokehPixel({ x: 150, y: 24 }, bright, { surface: BOKEH_DARK_SURFACE, blend: 'screen', fade: 0.8 });

    expect(contrast(ink, pixel)).toBeGreaterThanOrEqual(4.5);
  });

  it('lifts a dark high grade instead of leaving it unreadable', () => {
    const dark = V_GRADE_COLORS.V17 ?? '#000000';

    expect(readableGradeColor(dark, [], [])).not.toBe(dark.toUpperCase());
  });
});

// The Kotlin painter is tested against this same file, so it can't drift from
// the app's bokeh without one of the two suites going red.
describe('card-art-golden.json', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../../modules/live-activity/android/src/test/resources/card-art-golden.json', import.meta.url),
      'utf8',
    ),
  ) as { blobs: BokehBlob[]; samples: { x: number; y: number; hex: string }[] };

  it('still matches bokehPixel', () => {
    for (const { x, y, hex } of fixture.samples) {
      expect(bokehPixel({ x, y }, fixture.blobs, { surface: BOKEH_DARK_SURFACE, blend: 'screen' })).toBe(hex);
    }
  });
});
