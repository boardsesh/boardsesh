import { describe, expect, it } from 'vitest';
import { useReduceTransparency } from '../use-reduce-transparency.web';

describe('useReduceTransparency on web', () => {
  it('uses the opaque fallback when the browser cannot expose the OS preference', () => {
    expect(useReduceTransparency()).toBe(true);
  });
});
