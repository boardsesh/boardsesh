import { describe, it, expect } from 'vitest';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import {
  isValidFrameSegment,
  isValidFramesString,
  normalizeOutputFormat,
  ogClimbQuerySchema,
  VALID_BOARD_NAMES,
  MAX_FRAMES_LENGTH,
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
    for (const name of ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper', 'soill']) {
      expect(VALID_BOARD_NAMES.has(name)).toBe(true);
    }
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
});
