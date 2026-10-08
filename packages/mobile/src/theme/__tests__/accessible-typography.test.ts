import { describe, expect, it } from 'vitest';
import { boldTextWeight } from '../accessible-typography';
describe('Bold Text weights', () => {
  it('strengthens regular and explicit weights without exceeding black', () => {
    expect(boldTextWeight('normal')).toBe('500');
    expect(boldTextWeight('600')).toBe('700');
    expect(boldTextWeight('900')).toBe('900');
  });
});
