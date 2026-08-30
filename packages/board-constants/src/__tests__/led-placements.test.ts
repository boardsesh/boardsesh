import { afterEach, describe, expect, it } from 'vite-plus/test';
import { buildFramesString, LED_PLACEMENTS } from '../led-placements';

const TEST_KEY = '9101-9201';

afterEach(() => {
  delete LED_PLACEMENTS.quantum[TEST_KEY];
});

describe('buildFramesString', () => {
  it('preserves placement id 0 instead of treating it as missing', () => {
    LED_PLACEMENTS.quantum[TEST_KEY] = { 0: 7 };

    expect(buildFramesString([{ position: 7, r: 0, g: 255, b: 0, role: 12 }], 'quantum', 9101, 9201)).toBe('p0r12');
  });
});
