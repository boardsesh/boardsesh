import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  OG_FAMILY_GROUND,
  OG_FAMILY_MUTED,
  OG_FAMILY_WHITE,
  OG_FAMILY_WORDMARK_LEFT,
  OG_FAMILY_WORDMARK_TOP,
  buildOgFamilyScrim,
  liftGradeColorForCard,
  ogFamilyGradeColor,
  renderOgFamilyTextLayers,
} from '../og-family';

const hero = (text: string) => ({ runs: [{ text, color: OG_FAMILY_WHITE }], maxPt: 60, wrap: true });
const row = (text: string) => ({ runs: [{ text, color: OG_FAMILY_MUTED }], sizePt: 24, weight: 700 });

describe('family text survives real-world names', () => {
  it.each([
    ['an ampersand and markup', 'Rock & Roll <3 "quotes"'],
    ['Pango-significant characters', '<b>bold</b> & &amp;'],
    ['right-to-left text', 'אבן הכותל'],
    ['arabic', 'صخرة التسلق'],
    ['japanese', 'カチカチ'],
    ['chinese', '张力感'],
    ['an emoji', '🧗 send'],
    ['cyrillic', 'Новый проект'],
    ['one very long word', 'Pneumonoultramicroscopicsilicovolcanoconiosis'],
  ])('renders %s without throwing', async (_label, text) => {
    const { layers, hero: heroRect } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: hero(`Join\n${text}`),
      rows: [row(text)],
    });

    expect(layers.length).toBeGreaterThanOrEqual(3);
    expect(heroRect.width).toBeGreaterThan(0);
    for (const layer of layers) {
      const metadata = await sharp(layer.input).metadata();
      expect(metadata.width).toBeGreaterThan(0);
    }
  });

  it('keeps a long hero name inside the crop and truncates only what it must', async () => {
    const { hero: heroRect } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: hero('Join\nMaximiliano-Bartholomew the Third of the Wall and his very long name'),
      rows: [],
    });

    expect(heroRect.left).toBe(590);
    expect(heroRect.left + heroRect.width).toBeLessThanOrEqual(915);
    expect(heroRect.height).toBeLessThanOrEqual(290);
  });

  it('draws the wordmark in the same place on every slot', async () => {
    for (const slot of ['full', 'narrow', 'none'] as const) {
      const { layers } = await renderOgFamilyTextLayers({
        slot,
        fontFamily: 'Noto Sans',
        hero: hero('Hello'),
        rows: [],
      });
      const wordmark = layers[layers.length - 1];
      expect(wordmark.left).toBe(OG_FAMILY_WORDMARK_LEFT);
      expect(wordmark.top).toBe(OG_FAMILY_WORDMARK_TOP);
    }
  });

  it('drops a row that would run past the floor rather than overlap', async () => {
    const { layers } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: { runs: [{ text: 'V5–V9', color: OG_FAMILY_WHITE }], maxPt: 96, wrap: false },
      rows: Array.from({ length: 30 }, (_value, index) => row(`Row number ${index}`)),
    });

    // hero + wordmark + some rows, never all thirty.
    expect(layers.length).toBeLessThan(30);
  });
});

describe('family grade colour lift', () => {
  function hue(hex: string): number {
    const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    if (delta === 0) return 0;
    const degrees =
      max === red ? ((green - blue) / delta) % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
    return (degrees * 60 + 360) % 360;
  }

  it('leaves a grade colour that already clears the bar alone', () => {
    expect(liftGradeColorForCard('#FFD400')).toBe('#FFD400');
  });

  it.each([
    ['V10', '#7E1C8E'],
    ['V14', '#5C1A87'],
    ['V16', '#38006B'],
  ])('lifts %s without changing its hue', (_grade, base) => {
    const lifted = liftGradeColorForCard(base);

    expect(lifted).not.toBe(base);
    expect(Math.abs(hue(lifted) - hue(base))).toBeLessThan(8);
  });

  it('reads a Font grade through the shared table, case-insensitively', () => {
    expect(ogFamilyGradeColor('7C')).toBe(ogFamilyGradeColor('7c'));
    expect(ogFamilyGradeColor('not-a-grade')).toBe('#F8FAFC');
  });
});

describe('family scrim', () => {
  it('paints the column near the family ground, with no art under it', async () => {
    const background = await sharp({
      create: { width: 1200, height: 630, channels: 4, background: { r: 200, g: 40, b: 200, alpha: 1 } },
    })
      .composite([{ input: buildOgFamilyScrim('full') }])
      .raw()
      .toBuffer();

    const pixelAt = (x: number, y: number) => {
      const index = (y * 1200 + x) * 4;
      return [background[index], background[index + 1], background[index + 2]];
    };
    const [red, green, blue] = pixelAt(800, 300);
    const [groundRed, groundGreen, groundBlue] = [1, 3, 5].map((offset) =>
      parseInt(OG_FAMILY_GROUND.slice(offset, offset + 2), 16),
    );

    expect(Math.abs(red - groundRed)).toBeLessThan(30);
    expect(Math.abs(green - groundGreen)).toBeLessThan(30);
    expect(Math.abs(blue - groundBlue)).toBeLessThan(30);
  });
});
