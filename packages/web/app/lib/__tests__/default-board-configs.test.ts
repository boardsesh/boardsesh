import { describe, it, expect } from 'vite-plus/test';
import { getDefaultBoardConfig, getDefaultClimbViewPath } from '../default-board-configs';

describe('getDefaultBoardConfig', () => {
  it('should return config for known board+layout', () => {
    const config = getDefaultBoardConfig('kilter', 1);
    expect(config).not.toBeNull();
    expect(config!.sizeId).toBe(7);
    expect(config!.setIds).toEqual([1, 20]);
  });

  it('should return null for unknown board+layout', () => {
    expect(getDefaultBoardConfig('kilter', 999)).toBeNull();
  });

  it('resolves the orphaned Kilter layouts that used to render no thumbnail', () => {
    // Layouts 2-7 are absent from the product-size tables but still appear in
    // historical ticks; the old hardcoded table returned null for them.
    expect(getDefaultBoardConfig('kilter', 2)).toEqual({ sizeId: 11, setIds: [21] });
  });

  it('resolves boards the old hardcoded table never listed', () => {
    const decoy = getDefaultBoardConfig('decoy', 2);
    expect(decoy).not.toBeNull();
    expect(decoy!.setIds.length).toBeGreaterThan(0);
  });

  it('agrees with mobile on the Tension Board 2 default (biggest size, not the 12x12)', () => {
    expect(getDefaultBoardConfig('tension', 11)?.sizeId).toBe(10);
  });
});

describe('getDefaultClimbViewPath', () => {
  it('should return slug-based URL for known config', () => {
    const result = getDefaultClimbViewPath('kilter', 1, 40, 'abc123');
    expect(result).not.toBeNull();
    // Should be a slug URL, not numeric
    expect(result).not.toContain('/1/7/');
    expect(result).toContain('/kilter/');
    expect(result).toContain('/40/view/abc123');
  });

  it('should include climb name in slug when provided', () => {
    const result = getDefaultClimbViewPath('kilter', 1, 40, 'abc123', 'Breakfast Burrito');
    expect(result).not.toBeNull();
    expect(result).toContain('breakfast-burrito-abc123');
  });

  it('should return null for unknown config', () => {
    const result = getDefaultClimbViewPath('kilter', 999, 40, 'abc123');
    expect(result).toBeNull();
  });

  it('should always return a string (not null) for known configs', () => {
    // This verifies the numeric fallback is in place
    const result = getDefaultClimbViewPath('kilter', 1, 40, 'abc123');
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
  });
});
