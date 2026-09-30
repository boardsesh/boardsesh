import { describe, expect, it } from 'vitest';
import { topShare } from './percentile';

describe('topShare', () => {
  it('rounds the way boardsesh.com does', () => {
    expect(topShare(95)).toBe('top 5%');
    expect(topShare(62.4)).toBe('top 38%');
    expect(topShare(99.5)).toBe('top 0.5%');
    expect(topShare(100)).toBe('top 0.1%');
  });

  it('says nothing before the climber is ranked', () => {
    expect(topShare(0)).toBeNull();
  });
});
