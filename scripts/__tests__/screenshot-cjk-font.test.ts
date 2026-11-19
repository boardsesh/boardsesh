import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderShowcaseText } from '../frame-screenshots';
import { PRESENTATION_ROOT, readCaptionCatalog } from '../lib/screenshot-presentation';

/** Read the TrueType BMP cmap, including glyph-zero gaps inside a segment. */
function glyphForCharacter(font: Buffer, character: number): number {
  for (let tableIndex = 0; tableIndex < font.readUInt16BE(4); tableIndex++) {
    const record = 12 + tableIndex * 16;
    if (font.toString('ascii', record, record + 4) !== 'cmap') continue;
    const cmapOffset = font.readUInt32BE(record + 8);
    for (let encodingIndex = 0; encodingIndex < font.readUInt16BE(cmapOffset + 2); encodingIndex++) {
      const encoding = cmapOffset + 4 + encodingIndex * 8;
      const subtable = cmapOffset + font.readUInt32BE(encoding + 4);
      if (font.readUInt16BE(subtable) !== 4) continue;
      const segmentCount = font.readUInt16BE(subtable + 6) / 2;
      const ends = subtable + 14;
      const starts = ends + segmentCount * 2 + 2;
      const deltas = starts + segmentCount * 2;
      const ranges = deltas + segmentCount * 2;
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
        const start = font.readUInt16BE(starts + segmentIndex * 2);
        const end = font.readUInt16BE(ends + segmentIndex * 2);
        if (character < start || character > end) continue;
        const delta = font.readInt16BE(deltas + segmentIndex * 2);
        const rangeOffset = font.readUInt16BE(ranges + segmentIndex * 2);
        if (rangeOffset === 0) return (character + delta + 0x10000) % 0x10000;
        const glyph = font.readUInt16BE(ranges + segmentIndex * 2 + rangeOffset + (character - start) * 2);
        return glyph === 0 ? 0 : (glyph + delta + 0x10000) % 0x10000;
      }
    }
  }
  return 0;
}

describe('pinned Chinese screenshot fonts', () => {
  it.each(['Regular', 'Bold'])('covers every Chinese caption character in %s', (style) => {
    const font = readFileSync(join(PRESENTATION_ROOT, 'fonts', `NotoSansSC-${style}.ttf`));
    const captions = Object.values(readCaptionCatalog('zh-CN'));
    const characters = new Set(captions.flatMap((caption) => Array.from(caption.headline + caption.description)));
    const missing = [...characters].filter(
      (character) => !/\s/.test(character) && glyphForCharacter(font, character.codePointAt(0)!) === 0,
    );
    expect(missing).toEqual([]);
  });

  it.each([{}, { bold: true }, { bold: true, emphasis: '攀岩', accent: '#AF91FF' }])(
    'renders Chinese through the compositor with %j',
    async (options) => {
      const rendered = await renderShowcaseText('一起攀岩', 48, 800, '#FFFFFF', options);
      const { width, height } = await sharp(rendered.data).metadata();
      expect(width).toBeGreaterThan(100);
      expect(height).toBeGreaterThan(20);
      expect(width).toBeLessThanOrEqual(800);
    },
  );
});
