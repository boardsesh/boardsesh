import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { escapePangoMarkup, MAX_CARD_NAME_CODEPOINTS, normalizeOgCardText, ogClimbQuerySchema } from '../validation';
import { buildOgClimbCardContent, ogCardGradeColor, renderOgCardLayers } from '../og-card';
import { OG_CARD_BOARD_BOX, OG_CARD_COLUMN_LEFT, placeOgBoard } from '../headers';
import { OG_FAMILY_GROUND, OG_FAMILY_WORDMARK_RIGHT, renderOgFamilyTextLayers } from '../og-family';
import { contrastRatio } from '@boardsesh/board-constants/readable-text-color';

const validQuery = {
  board_name: 'kilter',
  layout_id: '1',
  size_id: '10',
  set_ids: '1,20',
  frames: 'p1080r15',
};

describe('normalizeOgCardText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeOgCardText('  BING   BANG\tBOSH \n', 64)).toBe('BING BANG BOSH');
  });

  it('strips control characters', () => {
    expect(normalizeOgCardText('send\u0000 it\u0007', 64)).toBe('send it');
  });

  it('strips bidi overrides, isolates and zero-width characters', () => {
    const crafted = '\u202Eevil\u202C\u200B\u2066spoof\u2069\uFEFF';

    expect(normalizeOgCardText(crafted, 64)).toBe('evilspoof');
  });

  it('normalises to NFC so equivalent names key the same', () => {
    expect(normalizeOgCardText('Cafe\u0301', 64)).toBe(normalizeOgCardText('Café', 64));
  });

  it('truncates by code point, never splitting an emoji', () => {
    const truncated = normalizeOgCardText('\u{1F9D7}\u{1F9D7}\u{1F9D7}\u{1F9D7}', 2);

    expect(Array.from(truncated)).toHaveLength(2);
    expect(truncated).toBe('\u{1F9D7}\u{1F9D7}');
    // No LONE surrogate: a valid astral pair legitimately ends in a low one.
    expect(truncated).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('keeps the non-Latin names the catalogue actually contains', () => {
    // Real names, sampled from live climb pages: Japanese katakana, Chinese, and
    // an emoji-only name. A script allow-list would have blanked all three.
    expect(normalizeOgCardText('カチカチ', 64)).toBe('カチカチ');
    expect(normalizeOgCardText('張力感', 64)).toBe('張力感');
    expect(normalizeOgCardText('\u{1F92E}', 64)).toBe('\u{1F92E}');
  });

  it('keeps the joiner that holds a compound emoji together', () => {
    // U+200D is text, not decoration: strip it and a climber emoji becomes two
    // glyphs. U+200C is semantic in Persian and Arabic for the same reason.
    const climber = '\u{1F9D7}\u200D\u2640\uFE0F';

    expect(normalizeOgCardText(climber, 64)).toBe(climber);
    expect(normalizeOgCardText('\u0645\u06CC\u200C\u0631\u0648\u062F', 64)).toContain('\u200C');
  });

  it('returns an empty string when nothing survives', () => {
    expect(normalizeOgCardText('\u200B\u202E  ', 64)).toBe('');
  });
});

describe('escapePangoMarkup', () => {
  it('escapes every character Pango would read as markup', () => {
    expect(escapePangoMarkup(`Rock & Roll <span foreground="red">'`)).toBe(
      'Rock &amp; Roll &lt;span foreground=&quot;red&quot;&gt;&#39;',
    );
  });

  it('is what stops a real climb name from throwing', async () => {
    // libvips calls pango_parse_markup unconditionally — there is no plain-text
    // mode — so an unescaped `&` is a 500, not a rendering glitch.
    await expect(
      sharp({ text: { text: 'Rock & Roll', font: 'sans 20', rgba: true } })
        .png()
        .toBuffer(),
    ).rejects.toThrow(/invalid markup/);
    await expect(
      sharp({ text: { text: escapePangoMarkup('Rock & Roll'), font: 'sans 20', rgba: true } })
        .png()
        .toBuffer(),
    ).resolves.toBeInstanceOf(Buffer);
  });
});

describe('ogClimbQuerySchema card params', () => {
  it('accepts a query with no card params at all', () => {
    const parsed = ogClimbQuerySchema.parse(validQuery);

    expect(parsed.n).toBeUndefined();
    expect(parsed.g).toBeUndefined();
  });

  it('normalises the name and setter it keeps', () => {
    const parsed = ogClimbQuerySchema.parse({ ...validQuery, n: '  BING  BANG ', s: '\u202Ebigcheese' });

    expect(parsed.n).toBe('BING BANG');
    expect(parsed.s).toBe('bigcheese');
  });

  it('rejects an over-long name before normalising it', () => {
    const result = ogClimbQuerySchema.safeParse({ ...validQuery, n: 'a'.repeat(513) });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe('n is too large');
  });

  it('truncates a long-but-allowed name to the drawn budget', () => {
    const parsed = ogClimbQuerySchema.parse({ ...validQuery, n: 'a'.repeat(200) });

    expect(Array.from(parsed.n ?? '')).toHaveLength(MAX_CARD_NAME_CODEPOINTS);
  });

  it('accepts every grade vocabulary we render', () => {
    for (const grade of ['V7', '7B+', '6c+', '5.12a', 'V8/7B', '7a/V6']) {
      expect(ogClimbQuerySchema.safeParse({ ...validQuery, g: grade }).success, grade).toBe(true);
    }
  });

  it('rejects free text in the grade slot', () => {
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, g: '<b>V7</b>' }).success).toBe(false);
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, g: 'カチ' }).success).toBe(false);
  });

  it('keys a blank grade as no grade at all', () => {
    // The charset admits spaces, so this passed the regex, rendered nothing,
    // and still minted its own byte-cache entry.
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, g: '   ' }).success).toBe(false);
  });

  it('bounds the angle without clipping a real board', () => {
    expect(ogClimbQuerySchema.parse({ ...validQuery, angle: '40' }).angle).toBe(40);
    // Grasshopper's list starts at -5, so a negative angle has to survive;
    // `og-card-angles.test.ts` walks every board's list.
    expect(ogClimbQuerySchema.parse({ ...validQuery, angle: '-5' }).angle).toBe(-5);
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, angle: '91' }).success).toBe(false);
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, angle: '-91' }).success).toBe(false);
  });
});

describe('renderOgCardLayers', () => {
  it('draws nothing when there is nothing to say', async () => {
    // A card built by an already-shipped client that sends no text params gets
    // the board and no empty furniture.
    expect(await renderOgCardLayers({})).toEqual([]);
  });

  it('keeps a right-to-left setter or name on the column edge, under the grade', async () => {
    // One left-aligned stack: an Arabic or Hebrew line keeps its own letter order
    // but starts where every other line starts, so the rows never split across
    // two edges.
    for (const content of [
      { grade: 'V7', setter: 'تسلق' },
      { grade: 'V7', name: 'מסלול לנגה נגה ואלומה' },
    ]) {
      const layers = await renderOgCardLayers(content);
      expect(layers).not.toHaveLength(0);
      for (const layer of layers.slice(0, -1)) expect(layer.left).toBeGreaterThanOrEqual(OG_CARD_COLUMN_LEFT);
      expect(layers[0].left).toBe(OG_CARD_COLUMN_LEFT);
    }
  });

  it('keeps a long board line inside the column', async () => {
    // Unbounded, a line like this ran past the column and was clipped at the
    // canvas edge rather than wrapping.
    const layers = await renderOgCardLayers({
      grade: 'V4',
      boardLine: 'Touchstone \u00B7 Dungeon Trainer \u00B7 Full Size Commercial',
      setter: 'someone with quite a long name indeed',
    });

    for (const layer of layers) {
      const { width } = await sharp(layer.input).metadata();
      expect(layer.left + (width ?? 0), 'layer runs past the canvas').toBeLessThanOrEqual(1200);
    }
  });

  it('keeps every layer on the canvas for a name long enough to truncate', async () => {
    const layers = await renderOgCardLayers({
      name: 'A Preposterously Long Climb Name That Nobody Would Ever Actually Set On A Board',
      grade: '8a/V11',
      setter: 'verbosesetter',
      angle: 50,
      boardLine: 'Kilter · Original · 12 x 12 Square',
    });

    for (const layer of layers) {
      expect(layer.top).toBeGreaterThanOrEqual(0);
      expect(layer.top).toBeLessThan(630);
      expect(layer.left).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('card geometry and direction', () => {
  it('still draws a card that only knows the wall angle', async () => {
    // The early return used to swallow this before the angle-only row could
    // draw it, so a card with an angle and nothing else came back empty.
    expect(await renderOgCardLayers({ angle: 40 })).not.toHaveLength(0);
  });

  it('puts the wordmark in the family spot whatever direction the name runs', async () => {
    for (const name of ['BING BANG BOSH', 'تسلق الصخور']) {
      const layers = await renderOgCardLayers({ name, grade: 'V7' });
      // The wordmark is always the last layer, and is never dropped.
      const wordmark = layers.at(-1)!;
      const { width } = await sharp(wordmark.input).metadata();
      expect(wordmark.left + (width ?? 0)).toBe(OG_FAMILY_WORDMARK_RIGHT);
    }
  });

  it('never places the board outside its box', () => {
    // The scale that sizes the board and the subtraction that places it round
    // independently, so a board a fraction wider than its box must clamp rather
    // than take a negative offset that sharp clips in silence.
    const overshoot = placeOgBoard(OG_CARD_BOARD_BOX.width + 1, OG_CARD_BOARD_BOX.height + 1);

    expect(overshoot.left).toBeGreaterThanOrEqual(OG_CARD_BOARD_BOX.left);
    expect(overshoot.top).toBeGreaterThanOrEqual(OG_CARD_BOARD_BOX.top);
  });
});

describe('what the climb card says', () => {
  it('leads with the grade in its lifted grade colour, then name, setter and board line with the angle', () => {
    const content = buildOgClimbCardContent({
      name: 'Kiel training 1:4',
      grade: '7a/V6',
      setter: 'KilterStudio',
      angle: 40,
      boardLine: 'Kilter · 12 x 12 with kickboard',
    });

    expect(content?.slot).toBe('full');
    expect(content?.hero.runs).toEqual([{ text: '7a/V6', color: ogCardGradeColor('7a/V6') }]);
    expect(content?.hero.wrap).toBe(false);
    expect(content?.rows.map((row) => row.runs.map((run) => run.text).join(''))).toEqual([
      'Kiel training 1:4',
      'KilterStudio',
      'Kilter · 12 x 12 with kickboard · 40°',
    ]);
  });

  it('never draws a block from og-family-blocks.ts, which the render version does not hash', () => {
    // Avatar, pill, dots and bars are drawn in an unhashed file. If the climb card
    // ever asks for one, an edit there would change climb card pixels under an
    // unchanged URL: add og-family-blocks.ts to OPAQUE_RENDER_INPUTS first.
    const everyField = {
      name: 'n',
      grade: '7a/V6',
      setter: 's',
      angle: 40,
      boardLine: 'Kilter · Original',
      fontFamily: 'Noto Sans',
    };
    for (const content of [everyField, { boardLine: 'Kilter · Original' }, { angle: 40 }, { setter: 's' }]) {
      const family = buildOgClimbCardContent(content);
      expect(family).not.toBeNull();
      expect(family).not.toHaveProperty('identity');
      expect(family).not.toHaveProperty('pill');
      expect(family).not.toHaveProperty('dots');
      expect(family).not.toHaveProperty('bars');
    }
  });

  it('lifts every hard grade so it reads on the dark ground', () => {
    // V10 and up are deep purples on the grade scale; on #181225 they vanished.
    for (const grade of ['7c+/V10', '8a/V11', '8b+/V14', '8C+/V16']) {
      expect(contrastRatio(ogCardGradeColor(grade), OG_FAMILY_GROUND), grade).toBeGreaterThanOrEqual(4.5);
    }
    expect(ogCardGradeColor('not a grade')).toBe('#F8FAFC');
  });

  it('leads with the name when there is no grade', () => {
    const content = buildOgClimbCardContent({ name: 'Ungraded', setter: 'someone', boardLine: 'Kilter · Original' });

    expect(content?.hero.runs[0].text).toBe('Ungraded');
    expect(content?.hero.wrap).toBe(true);
  });

  it('gives an already-shipped binary that sends no identity a card led by the board brand', () => {
    const content = buildOgClimbCardContent({ boardLine: 'Kilter · Original · 12 x 12 Square' });

    expect(content?.hero.runs[0].text).toBe('Kilter');
    expect(content?.rows.map((row) => row.runs[0].text)).toEqual(['Original · 12 x 12 Square']);
  });

  it.each(['8C+/V16', '8c+/V16', '7c+/V10', '8B+/V14'])('keeps %s whole inside the search crop', async (grade) => {
    const content = buildOgClimbCardContent({
      grade,
      name: 'A climb name that takes three lines of the column to say all of',
      setter: 'someone',
      angle: 40,
      boardLine: 'Touchstone · Dungeon Trainer · Full Size Commercial',
      fontFamily: 'Noto Sans',
    });
    const { hero } = await renderOgFamilyTextLayers(content!);

    expect(hero.left).toBeGreaterThanOrEqual(285);
    expect(hero.left + hero.width).toBeLessThanOrEqual(915);
  });
});
