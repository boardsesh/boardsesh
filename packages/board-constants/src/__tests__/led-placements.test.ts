import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { buildFramesString, LED_PLACEMENTS } from '../led-placements';

const TEST_KEY = '9101-9201';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildFramesString', () => {
  it('preserves placement id 0 instead of treating it as missing', () => {
    vi.spyOn(LED_PLACEMENTS, 'quantum', 'get').mockReturnValue({ [TEST_KEY]: { 0: 7 } });

    expect(buildFramesString([{ position: 7, r: 0, g: 255, b: 0, role: 12 }], 'quantum', 9101, 9201)).toBe('p0r12');
  });
});
