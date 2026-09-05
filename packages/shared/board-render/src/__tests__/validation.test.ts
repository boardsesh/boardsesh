// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

import { describe, it, expect } from 'vitest';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import {
  boardseshRenderQuerySchema,
  fieldColorSchema,
  glowFalloffSchema,
  glyphsQuerySchema,
  isValidFrameSegment,
  isValidFramesString,
  normalizeOutputFormat,
  ogClimbQuerySchema,
  renderModeSchema,
  VALID_BOARD_NAMES,
  MAX_FRAMES_LENGTH,
  MAX_SET_IDS_LENGTH,
} from '../validation';

describe('normalizeOutputFormat', () => {
  it('maps jpg to jpeg', () => {
    expect(normalizeOutputFormat('jpg')).toBe('jpeg');
  });

  it('passes through webp, png, jpeg', () => {
    expect(normalizeOutputFormat('webp')).toBe('webp');
    expect(normalizeOutputFormat('png')).toBe('png');
    expect(normalizeOutputFormat('jpeg')).toBe('jpeg');
  });

  it('returns null for unknown formats', () => {
    expect(normalizeOutputFormat('gif')).toBeNull();
    expect(normalizeOutputFormat('')).toBeNull();
  });
});

describe('isValidFrameSegment', () => {
  it('accepts a simple placement/role run', () => {
    expect(isValidFrameSegment('p1073r42p1090r43')).toBe(true);
  });

  it('accepts a quoted Aurora delta marker', () => {
    expect(isValidFrameSegment('"p1090r43')).toBe(true);
  });

  it('accepts x-removals interleaved with placements', () => {
    expect(isValidFrameSegment('x1073p1100r44')).toBe(true);
  });

  it('rejects an empty segment', () => {
    expect(isValidFrameSegment('')).toBe(false);
  });

  it('rejects a lone quote', () => {
    expect(isValidFrameSegment('"')).toBe(false);
  });

  it('rejects malformed content', () => {
    expect(isValidFrameSegment('p1073r42<script>')).toBe(false);
    expect(isValidFrameSegment('p1073')).toBe(false);
    expect(isValidFrameSegment('pr42')).toBe(false);
  });
});

describe('isValidFramesString', () => {
  it('accepts an empty frames string', () => {
    expect(isValidFramesString('')).toBe(true);
  });

  it('accepts multiple comma-separated segments', () => {
    expect(isValidFramesString('p1073r42,"p1090r43,"x1073p1100r44')).toBe(true);
  });

  it.each([',', 'p1r42,,p2r43', 'p1r42"p2r43', '"'])('rejects malformed separators: %s', (frames) => {
    expect(isValidFramesString(frames)).toBe(false);
  });
});

describe('VALID_BOARD_NAMES', () => {
  it('includes every supported board', () => {
    for (const name of ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper', 'soill', 'woods']) {
      expect(VALID_BOARD_NAMES.has(name)).toBe(true);
    }
  });

  it('is exactly SUPPORTED_BOARDS, so a new board can never be a silent 400', () => {
    expect([...VALID_BOARD_NAMES].sort()).toEqual([...SUPPORTED_BOARDS].sort());
  });

  it('rejects unknown boards', () => {
    expect(VALID_BOARD_NAMES.has('evil')).toBe(false);
  });

  it('every valid board has hold states — buildRenderConfig requires them at render time', () => {
    for (const boardName of VALID_BOARD_NAMES) {
      expect(HOLD_STATE_MAP, `HOLD_STATE_MAP is missing "${boardName}"`).toHaveProperty(boardName);
    }
  });
});

describe('ogClimbQuerySchema', () => {
  const valid = {
    board_name: 'kilter',
    layout_id: '1',
    size_id: '10',
    set_ids: '1,20',
    frames: 'p1080r15p1202r12',
  };

  it('parses and coerces a valid query', () => {
    const parsed = ogClimbQuerySchema.parse(valid);
    expect(parsed.board_name).toBe('kilter');
    expect(parsed.layout_id).toBe(1);
    expect(parsed.size_id).toBe(10);
    expect(parsed.set_ids).toBe('1,20');
    expect(parsed.frames).toBe('p1080r15p1202r12');
  });

  it('rejects an empty frames string (a blank board must not be cacheable as a climb card)', () => {
    expect(ogClimbQuerySchema.safeParse({ ...valid, frames: '' }).success).toBe(false);
  });

  it('accepts a single set id', () => {
    expect(ogClimbQuerySchema.parse({ ...valid, set_ids: '1' }).set_ids).toBe('1');
  });

  it('rejects an invalid board_name', () => {
    expect(ogClimbQuerySchema.safeParse({ ...valid, board_name: 'evil' }).success).toBe(false);
  });

  it('accepts a Woods share card', () => {
    const parsed = ogClimbQuerySchema.parse({
      ...valid,
      board_name: 'woods',
      layout_id: '1',
      size_id: '2',
      set_ids: '1',
    });
    expect(parsed.board_name).toBe('woods');
    expect(parsed.size_id).toBe(2);
    expect(parsed.set_ids).toBe('1');
  });

  it('rejects non-numeric set_ids', () => {
    expect(ogClimbQuerySchema.safeParse({ ...valid, set_ids: '1,a' }).success).toBe(false);
    expect(ogClimbQuerySchema.safeParse({ ...valid, set_ids: '1,' }).success).toBe(false);
  });

  it('canonicalises set_ids by sorting and deduplicating', () => {
    expect(ogClimbQuerySchema.parse({ ...valid, set_ids: '20,1' }).set_ids).toBe('1,20');
    expect(ogClimbQuerySchema.parse({ ...valid, set_ids: '20,1,20,1' }).set_ids).toBe('1,20');
    expect(ogClimbQuerySchema.parse({ ...valid, set_ids: '007,20' }).set_ids).toBe('7,20');
  });

  it('rejects more set_ids than MAX_SET_IDS', () => {
    const tooManySetIds = Array.from({ length: 11 }, (_, index) => index + 1).join(',');
    expect(ogClimbQuerySchema.safeParse({ ...valid, set_ids: tooManySetIds }).success).toBe(false);
  });

  it('rejects an oversized set_ids string before syntax validation', () => {
    const oversizedSetIds = '1'.repeat(MAX_SET_IDS_LENGTH + 1);
    const result = ogClimbQuerySchema.safeParse({ ...valid, set_ids: oversizedSetIds });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe('set_ids is too large');
  });

  it('rejects malformed frames', () => {
    expect(ogClimbQuerySchema.safeParse({ ...valid, frames: 'p1073r42<script>' }).success).toBe(false);
  });

  it('rejects a frames string over the cap', () => {
    expect(ogClimbQuerySchema.safeParse({ ...valid, frames: 'p1r42'.repeat(MAX_FRAMES_LENGTH) }).success).toBe(false);
  });

  it('accepts jpg/jpeg/png/webp formats and omitted format', () => {
    for (const format of ['jpg', 'jpeg', 'png', 'webp']) {
      expect(ogClimbQuerySchema.safeParse({ ...valid, format }).success).toBe(true);
    }
    expect(ogClimbQuerySchema.parse(valid).format).toBeUndefined();
  });

  it('rejects an unknown format', () => {
    expect(ogClimbQuerySchema.safeParse({ ...valid, format: 'gif' }).success).toBe(false);
  });

  it('defaults render_mode to aura, and glow_falloff / glyphs to soft / off', () => {
    // A caller that names no drawing gets the one the app draws. Every
    // Boardsesh caller sends it explicitly anyway (the params are the cache
    // key); this default is for the ones we do not control — a store binary
    // from before the change, a third-party embed.
    const parsed = ogClimbQuerySchema.parse(valid);
    expect(parsed.render_mode).toBe('aura');
    expect(parsed.glow_falloff).toBe('soft');
    expect(parsed.glyphs).toBe(false);
    expect(parsed.field_color).toBeUndefined();
  });

  it('accepts glow_falloff=plateau', () => {
    expect(ogClimbQuerySchema.parse({ ...valid, glow_falloff: 'plateau' }).glow_falloff).toBe('plateau');
  });

  it('still serves classic when it is asked for by name', () => {
    expect(ogClimbQuerySchema.parse({ ...valid, render_mode: 'classic' }).render_mode).toBe('classic');
  });

  it('rejects an invalid render_mode, glow_falloff, or field_color', () => {
    expect(ogClimbQuerySchema.safeParse({ ...valid, render_mode: 'neon' }).success).toBe(false);
    expect(ogClimbQuerySchema.safeParse({ ...valid, glow_falloff: 'hard' }).success).toBe(false);
    expect(ogClimbQuerySchema.safeParse({ ...valid, field_color: 'blue' }).success).toBe(false);
    expect(ogClimbQuerySchema.safeParse({ ...valid, field_color: '#12345' }).success).toBe(false);
  });
});

describe('renderModeSchema / glowFalloffSchema / glyphsQuerySchema / fieldColorSchema', () => {
  it('renderModeSchema defaults to aura and still accepts classic', () => {
    expect(renderModeSchema.parse(undefined)).toBe('aura');
    expect(renderModeSchema.parse('classic')).toBe('classic');
    expect(renderModeSchema.safeParse('evil').success).toBe(false);
  });

  it('glowFalloffSchema defaults to soft and accepts plateau', () => {
    expect(glowFalloffSchema.parse(undefined)).toBe('soft');
    expect(glowFalloffSchema.parse('plateau')).toBe('plateau');
    expect(glowFalloffSchema.safeParse('hard').success).toBe(false);
  });

  it('glyphsQuerySchema accepts 0/1/true/false and defaults unset to false', () => {
    expect(glyphsQuerySchema.parse(undefined)).toBe(false);
    expect(glyphsQuerySchema.parse('0')).toBe(false);
    expect(glyphsQuerySchema.parse('false')).toBe(false);
    expect(glyphsQuerySchema.parse('1')).toBe(true);
    expect(glyphsQuerySchema.parse('true')).toBe(true);
    expect(glyphsQuerySchema.safeParse('yes').success).toBe(false);
  });

  it('fieldColorSchema accepts a #rrggbb hex color and leaves it unset when omitted', () => {
    expect(fieldColorSchema.parse(undefined)).toBeUndefined();
    expect(fieldColorSchema.parse('#181225')).toBe('#181225');
    expect(fieldColorSchema.safeParse('#fff').success).toBe(false);
    expect(fieldColorSchema.safeParse('181225').success).toBe(false);
  });

  it('boardseshRenderQuerySchema parses all four with defaults', () => {
    const parsed = boardseshRenderQuerySchema.parse({});
    expect(parsed).toEqual({ render_mode: 'aura', glow_falloff: 'soft', glyphs: false, field_color: undefined });
  });
});
