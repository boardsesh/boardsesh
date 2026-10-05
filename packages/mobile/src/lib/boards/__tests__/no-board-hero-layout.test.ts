import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../theme/colors', () => ({
  androidFallbackColors: { light: { background: '#F4F1FB' }, dark: { background: '#0F0B16' } },
}));

const { computeNoBoardHeroBox, noBoardStageColors, sceneBackgroundHex } = await import('../no-board-hero-layout');

// Board width over height. A Kilter 12x12 is portrait; a Tension 2 is close to
// square.
const PORTRAIT = 1080 / 1500;
const NEAR_SQUARE = 0.95;

const PRO = { windowWidth: 393, windowHeight: 852, insetTop: 59, floatingControlBottom: 90 };
const SE = { windowWidth: 375, windowHeight: 667, insetTop: 20, floatingControlBottom: 90 };

describe('computeNoBoardHeroBox', () => {
  it('caps the board at 380 points on a tall phone', () => {
    expect(computeNoBoardHeroBox({ ...PRO, hasChips: true, aspect: PORTRAIT })).toEqual({ width: 274, height: 380 });
  });

  // 667 - 20 - 90 - 50 - 230: the board, the caption, and the next row's
  // thumbnail top and name all fit above the docked button.
  it('shrinks the board on an iPhone SE so the caption and a row still fit', () => {
    const box = computeNoBoardHeroBox({ ...SE, hasChips: true, aspect: PORTRAIT });

    expect(box.height).toBe(277);
    expect(box.height).toBeGreaterThanOrEqual(200);
  });

  it('gives the board the chip row when there is only one board type', () => {
    const withChips = computeNoBoardHeroBox({ ...SE, hasChips: true, aspect: PORTRAIT });
    const withoutChips = computeNoBoardHeroBox({ ...SE, hasChips: false, aspect: PORTRAIT });

    expect(withoutChips.height - withChips.height).toBe(44);
  });

  it('never goes under 200 points, however short the window', () => {
    const box = computeNoBoardHeroBox({ ...SE, windowHeight: 480, hasChips: true, aspect: PORTRAIT });

    expect(box.height).toBe(200);
  });

  // A near-square board at 380 tall would be 361 wide: it fits a 393-point
  // phone with its gutters exactly, and not a 375-point one.
  it('keeps a wide board inside the gutters and takes the height from the width', () => {
    const box = computeNoBoardHeroBox({ ...PRO, windowWidth: 375, hasChips: true, aspect: NEAR_SQUARE });

    expect(box.width).toBe(343);
    expect(box.height).toBe(Math.round(343 / NEAR_SQUARE));
  });

  it('keeps the board its own shape', () => {
    const box = computeNoBoardHeroBox({ ...PRO, hasChips: true, aspect: NEAR_SQUARE });

    expect(box.width / box.height).toBeCloseTo(NEAR_SQUARE, 2);
  });
});

describe('sceneBackgroundHex', () => {
  it('is the system background on iOS glass', () => {
    expect(sceneBackgroundHex('liquidGlass', 'dark', 'ios')).toBe('#000000');
    expect(sceneBackgroundHex('liquidGlass', 'light', 'ios')).toBe('#FFFFFF');
  });

  it('is the fallback background off iOS', () => {
    expect(sceneBackgroundHex('liquidGlass', 'dark', 'android')).toBe('#0F0B16');
    expect(sceneBackgroundHex('liquidGlass', 'light', 'web')).toBe('#F4F1FB');
  });

  it('is the Material surface on the Material variant, on any platform', () => {
    expect(sceneBackgroundHex('material', 'dark', 'ios')).toBe(sceneBackgroundHex('material', 'dark', 'android'));
    expect(sceneBackgroundHex('material', 'dark', 'android')).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe('noBoardStageColors', () => {
  // `expo-linear-gradient` cannot take a PlatformColor, and a fade through
  // `transparent` passes through grey.
  it('is all concrete colours, with a clear end that keeps its hue', () => {
    const stage = noBoardStageColors('#000000', '#A78BFA', 'dark');

    expect(stage.glow).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(stage.glow).not.toBe('#000000');
    expect(stage.background).toBe('#000000');
    expect(stage.backgroundClear).toBe('rgba(0, 0, 0, 0)');
    expect(stage.cardBorder).toMatch(/^rgba\(/);
  });

  it('tints a light page less than a dark one', () => {
    const light = noBoardStageColors('#FFFFFF', '#6D28D9', 'light');

    // 16% violet over white stays a pale lavender.
    expect(light.glow.toUpperCase()).toBe('#E8DDF9');
  });

  // A pale wall on a white page: the card edge is the brand violet, not the
  // system separator.
  it('edges the board in violet on a light page', () => {
    const light = noBoardStageColors('#FFFFFF', '#6D28D9', 'light');

    expect(light.cardBorder).toBe('rgba(109, 40, 217, 0.3)');
  });
});
