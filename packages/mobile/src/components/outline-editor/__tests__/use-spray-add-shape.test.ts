import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/preference-store', () => ({
  getPreference: vi.fn(),
  setPreference: vi.fn(),
}));

import { DEFAULT_SPRAY_ADD_SHAPE, parseSprayAddShape } from '../use-spray-add-shape';

describe('parseSprayAddShape', () => {
  it('reads back both stored shapes', () => {
    expect(parseSprayAddShape('draw')).toBe('draw');
    expect(parseSprayAddShape('corners')).toBe('corners');
  });

  it('falls back to Draw for nothing stored or anything unexpected', () => {
    expect(DEFAULT_SPRAY_ADD_SHAPE).toBe('draw');
    expect(parseSprayAddShape(null)).toBe('draw');
    expect(parseSprayAddShape(undefined)).toBe('draw');
    expect(parseSprayAddShape('polygon')).toBe('draw');
    expect(parseSprayAddShape(3)).toBe('draw');
  });
});
