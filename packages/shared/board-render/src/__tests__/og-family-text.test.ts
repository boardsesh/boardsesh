import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  OG_FAMILY_GROUND,
  OG_FAMILY_ICON_GAP,
  OG_FAMILY_ICON_PATH,
  OG_FAMILY_ICON_SIZE,
  OG_FAMILY_MUTED,
  OG_FAMILY_WHITE,
  OG_FAMILY_WORDMARK_RIGHT,
  OG_FAMILY_WORDMARK_TOP,
  buildOgFamilyScrim,
  liftGradeColorForCard,
  ogFamilyGradeColor,
  renderOgFamilyTextLayers,
  resetOgFamilyIcon,
} from '../og-family';
import { renderOgCardText } from '../og-card';

const APP_ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../../web/app/icon.png');

/** First inked column and the inked rows of a raw RGBA raster. */
function inkBounds({ data, info }: { data: Buffer; info: { width: number; height: number; channels: number } }) {
  let left = info.width;
  let top = info.height;
  let bottom = -1;
  for (let row = 0; row < info.height; row++) {
    for (let column = 0; column < info.width; column++) {
      if (data[(row * info.width + column) * info.channels + info.channels - 1] <= 8) continue;
      left = Math.min(left, column);
      top = Math.min(top, row);
      bottom = row;
    }
  }
  return { left, top, bottom };
}

const hero = (text: string) => ({ runs: [{ text, color: OG_FAMILY_WHITE }], maxPt: 60, wrap: true });
const row = (text: string) => ({ runs: [{ text, color: OG_FAMILY_MUTED }], sizePt: 24, weight: 700 });

describe('place card text', () => {
  const eyebrow = { runs: [{ text: 'Kilter 40°', color: OG_FAMILY_MUTED }], sizePt: 26, weight: 700 };

  it('stacks the eyebrow above the hero', async () => {
    const without = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: hero('Kaserne'),
      rows: [],
    });
    const withEyebrow = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      eyebrow,
      hero: hero('Kaserne'),
      rows: [],
    });

    expect(withEyebrow.layers).toHaveLength(without.layers.length + 1);
    const eyebrowLayer = withEyebrow.layers[0];
    expect(eyebrowLayer.top).toBeLessThan(withEyebrow.hero.top);
  });

  it('draws the app icon left of the wordmark, centred on its letters, on every slot', async () => {
    for (const slot of ['full', 'narrow', 'none'] as const) {
      const { layers, brand } = await renderOgFamilyTextLayers({
        slot,
        fontFamily: 'Noto Sans',
        hero: hero('Kaserne'),
        rows: [],
      });
      const [icon, wordmark] = layers.slice(-2);
      const iconRaster = await sharp(icon.input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const wordmarkRaster = await sharp(wordmark.input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const wordmarkInk = inkBounds(wordmarkRaster);

      expect(iconRaster.info).toMatchObject({ width: OG_FAMILY_ICON_SIZE, height: OG_FAMILY_ICON_SIZE });
      expect(wordmark.left + wordmarkInk.left - (icon.left + OG_FAMILY_ICON_SIZE)).toBe(OG_FAMILY_ICON_GAP);
      const iconCentre = icon.top + OG_FAMILY_ICON_SIZE / 2;
      const lettersCentre = wordmark.top + (wordmarkInk.top + wordmarkInk.bottom + 1) / 2;
      expect(Math.abs(iconCentre - lettersCentre)).toBeLessThanOrEqual(0.5);
      expect(brand).toMatchObject({ left: icon.left, width: OG_FAMILY_WORDMARK_RIGHT - icon.left });
    }
  });

  it('rounds the icon corners and keeps its middle opaque', async () => {
    const { layers } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: hero('A'),
      rows: [],
    });
    const { data, info } = await sharp(layers.at(-2)!.input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (column: number, row: number) => data[(row * info.width + column) * info.channels + 3];

    for (const [column, row] of [
      [0, 0],
      [info.width - 1, 0],
      [0, info.height - 1],
      [info.width - 1, info.height - 1],
    ]) {
      expect(alphaAt(column, row), `${column},${row}`).toBe(0);
    }
    expect(alphaAt(info.width / 2, info.height / 2)).toBe(255);
    expect(alphaAt(info.width / 2, 0)).toBe(255);
  });

  describe('when the icon cannot be read', () => {
    afterEach(() => resetOgFamilyIcon());

    it('keeps every word, draws the wordmark alone and says why the icon is missing', async () => {
      const content = {
        slot: 'full' as const,
        fontFamily: 'Noto Sans',
        hero: hero('Kaserne'),
        rows: [row('Kilter 40°')],
      };
      const withIcon = await renderOgFamilyTextLayers(content);
      resetOgFamilyIcon(join(dirname(OG_FAMILY_ICON_PATH), 'no-such-icon.png'));

      const withoutIcon = await renderOgFamilyTextLayers(content);

      expect(withIcon.iconError).toBeNull();
      expect(withoutIcon.iconError).toEqual(expect.any(String));
      // Every layer but the icon, in the same place: the words never pay for it.
      expect(withoutIcon.layers.map(({ left, top }) => ({ left, top }))).toEqual(
        withIcon.layers
          .filter((_layer, index) => index !== withIcon.layers.length - 2)
          .map(({ left, top }) => ({ left, top })),
      );
      const wordmark = withoutIcon.layers.at(-1)!;
      expect(wordmark.left + ((await sharp(wordmark.input).metadata()).width ?? 0)).toBe(OG_FAMILY_WORDMARK_RIGHT);
    });

    it('keeps the words on a climb card and reports the missing icon to the caller', async () => {
      resetOgFamilyIcon(join(dirname(OG_FAMILY_ICON_PATH), 'no-such-icon.png'));

      const { layers, iconError } = await renderOgCardText({
        grade: '7a/V6',
        name: 'Kiel training 1:4',
        setter: 'KilterStudio',
        angle: 40,
      });

      expect(iconError).toEqual(expect.any(String));
      // Grade, name, setter, angle line and the wordmark.
      expect(layers).toHaveLength(5);
    });

    it('does not remember a failed read: the next card draws the icon once the file is back', async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'og-icon-'));
      const laterIconPath = join(scratch, 'og-app-icon.png');
      resetOgFamilyIcon(laterIconPath);
      const content = { slot: 'none' as const, fontFamily: 'Noto Sans', hero: hero('Pinnacle'), rows: [] };
      expect((await renderOgFamilyTextLayers(content)).iconError).not.toBeNull();

      await copyFile(OG_FAMILY_ICON_PATH, laterIconPath);
      const recovered = await renderOgFamilyTextLayers(content);
      await rm(scratch, { recursive: true });

      expect(recovered.iconError).toBeNull();
      expect((await sharp(recovered.layers.at(-2)!.input).metadata()).width).toBe(OG_FAMILY_ICON_SIZE);
    });
  });

  it('draws the committed icon, which is the app icon at card size', async () => {
    const committed = await sharp(OG_FAMILY_ICON_PATH).raw().toBuffer({ resolveWithObject: true });
    const appIcon = await sharp(APP_ICON_PATH)
      .resize(OG_FAMILY_ICON_SIZE, OG_FAMILY_ICON_SIZE)
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(committed.info).toMatchObject({ width: OG_FAMILY_ICON_SIZE, height: OG_FAMILY_ICON_SIZE });
    expect(committed.info.channels).toBe(appIcon.info.channels);
    let largestDifference = 0;
    for (let index = 0; index < committed.data.length; index++) {
      largestDifference = Math.max(largestDifference, Math.abs(committed.data[index] - appIcon.data[index]));
    }
    // A redrawn app icon fails here: regenerate the committed one from it.
    expect(largestDifference).toBeLessThanOrEqual(2);
  });

  it('does not hang a one-line wrapping hero left of the column on the bar of a T', async () => {
    const { hero: heroRect } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: hero('The Fold'),
      rows: [],
    });

    expect(heroRect.left).toBe(590);
  });
});

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

  it('keeps a long hero name inside the crop and well above the size of the line under it', async () => {
    const { hero: heroRect } = await renderOgFamilyTextLayers({
      slot: 'narrow',
      fontFamily: 'Noto Sans',
      hero: {
        runs: [
          {
            text: 'Join\nMaximiliano-Bartholomew the Third of the Wall and his very long name',
            color: OG_FAMILY_WHITE,
          },
        ],
        maxPt: 100,
        minPt: 44,
        wrap: true,
      },
      rows: [],
    });

    // The "J" of Join may hang left of the column, but stays inside the crop.
    expect(heroRect.left).toBeGreaterThanOrEqual(285);
    expect(heroRect.left).toBeLessThanOrEqual(322);
    expect(heroRect.left + heroRect.width).toBeLessThanOrEqual(915);
    expect(heroRect.height).toBeLessThanOrEqual(340);
    expect(heroRect.pt).toBeGreaterThanOrEqual(44);
  });

  it('keeps a right-to-left name whole and on the stack edge under an English prefix', async () => {
    const hebrew = await renderOgFamilyTextLayers({
      slot: 'narrow',
      fontFamily: 'Noto Sans',
      hero: {
        runs: [
          { text: 'Join\n', color: OG_FAMILY_WHITE },
          { text: 'דני כהן', color: OG_FAMILY_WHITE },
        ],
        maxPt: 100,
        minPt: 44,
        wrap: true,
      },
      rows: [],
    });
    const prefixOnly = await renderOgFamilyTextLayers({
      slot: 'narrow',
      fontFamily: 'Noto Sans',
      hero: { runs: [{ text: 'Join', color: OG_FAMILY_WHITE }], maxPt: hebrew.hero.pt, wrap: false },
      rows: [],
    });

    // Wider than "Join" alone: the name was drawn and not truncated away.
    expect(hebrew.hero.width).toBeGreaterThan(prefixOnly.hero.width);
    expect(hebrew.hero.pt).toBeGreaterThanOrEqual(70);
  });

  it('keeps every line of an unbroken name above the floor by truncating it', async () => {
    const { hero: heroRect } = await renderOgFamilyTextLayers({
      slot: 'narrow',
      fontFamily: 'Noto Sans',
      hero: { runs: [{ text: `Join\n${'W'.repeat(60)}`, color: OG_FAMILY_WHITE }], maxPt: 100, minPt: 44, wrap: true },
      rows: [],
    });

    expect(heroRect.pt).toBeGreaterThanOrEqual(44);
    expect(heroRect.left + heroRect.width).toBeLessThanOrEqual(915);
  });

  it('keeps two lines for a name that fits, instead of a fat three', async () => {
    const twoLine = await renderOgFamilyTextLayers({
      slot: 'narrow',
      fontFamily: 'Noto Sans',
      hero: { runs: [{ text: 'Join\nHuy Dang', color: OG_FAMILY_WHITE }], maxPt: 100, minPt: 44, wrap: true },
      rows: [],
    });

    expect(twoLine.hero.pt).toBeGreaterThanOrEqual(70);
    expect(twoLine.hero.height).toBeLessThanOrEqual(340);
  });

  it('centres the stack on a card with no art', async () => {
    const { hero: heroRect, layers } = await renderOgFamilyTextLayers({
      slot: 'none',
      fontFamily: 'Noto Sans',
      pill: { text: 'JOIN', color: OG_FAMILY_WHITE },
      hero: hero('Join\nDaniel'),
      rows: [row('Kilter at 40°')],
    });

    expect(Math.abs(heroRect.left + heroRect.width / 2 - 600)).toBeLessThanOrEqual(1);
    // The row sits under the icon and the wordmark.
    const rowLayer = layers[layers.length - 3];
    const { width } = await sharp(rowLayer.input).metadata();
    expect(Math.abs(rowLayer.left + (width ?? 0) / 2 - 600)).toBeLessThanOrEqual(1);
  });

  it('keeps a right-to-left name on the same edge as the rows around it', async () => {
    const { layers } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: { runs: [{ text: 'V5–V9', color: OG_FAMILY_WHITE }], maxPt: 78, wrap: false },
      rows: [row('117 climbs'), row('אבן הכותל'), row('Kilter playlist')],
    });

    expect(layers.slice(0, 4).map((layer) => layer.left)).toEqual([590, 590, 590, 590]);
  });

  it('anchors a whole right-to-left stack to the crop edge', async () => {
    const { layers, hero: heroRect } = await renderOgFamilyTextLayers({
      slot: 'full',
      fontFamily: 'Noto Sans',
      hero: { runs: [{ text: 'אבן הכותל', color: OG_FAMILY_WHITE }], maxPt: 60, wrap: true },
      rows: [row('Tension playlist')],
    });

    expect(heroRect.left + heroRect.width).toBe(915);
    const rowLayer = layers[1];
    const { width } = await sharp(rowLayer.input).metadata();
    expect(rowLayer.left + (width ?? 0)).toBe(915);
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
      const { width } = await sharp(wordmark.input).metadata();
      expect(wordmark.left + (width ?? 0)).toBe(OG_FAMILY_WORDMARK_RIGHT);
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

describe('family people cards survive real-world names', () => {
  it.each([
    ['an ampersand and markup', 'Tom & Jerry <crew> "quotes"'],
    ['right-to-left text', 'דני כהן'],
    ['arabic', 'محمد علي'],
    ['japanese', '田中さん'],
    ['cyrillic', 'Иван Семочкин'],
    ['a very long name', 'Maximiliano Bartholomew the Third of the Wall and his very long name'],
  ])('renders %s in every text slot without throwing', async (_label, text) => {
    const {
      layers,
      blocks,
      hero: heroRect,
    } = await renderOgFamilyTextLayers({
      slot: 'narrow',
      fontFamily: 'Noto Sans',
      identity: { name: text, avatar: { kind: 'monogram', letter: text.slice(0, 1), color: '#FFD400' }, sizePt: 34 },
      hero: { runs: [{ text: '7c+/V10', color: OG_FAMILY_WHITE }], maxPt: 170, wrap: false, tight: true },
      rows: [row(text)],
      dots: { dots: [{ color: '#FFD400', filled: true }], total: 1 },
      aside: { eyebrow: 'HARDEST SEND', title: text, lines: [text] },
    });

    expect(heroRect.width).toBeGreaterThan(0);
    expect(blocks.aside).toBeDefined();
    for (const layer of layers) {
      const metadata = await sharp(layer.input).metadata();
      expect(metadata.width).toBeGreaterThan(0);
    }
  });

  it('rejects rather than drawing a wordless card when text cannot render', async () => {
    // Pango fails on a NUL; the error has to reach the caller, never a cached blank.
    await expect(
      renderOgFamilyTextLayers({
        slot: 'full',
        fontFamily: 'Noto Sans',
        identity: { name: 'bad\u0000name', avatar: null, sizePt: 34 },
        hero: { runs: [{ text: '7a/V6', color: OG_FAMILY_WHITE }], maxPt: 96, wrap: false },
        rows: [],
      }),
    ).rejects.toThrow();
  });
});
