import { describe, expect, it } from 'vitest';
import { treeRssKiB } from '../store-video-measure';

describe('store video memory measurement', () => {
  it('counts descendants regardless of ordering and excludes unrelated runner processes', () => {
    expect(treeRssKiB('13 12 300\n90 1 99999\n12 11 200\n11 1 100', 11)).toBe(600);
  });
  it('tolerates an exited process and empty snapshots', () => {
    expect(treeRssKiB('', 42)).toBe(0);
    expect(treeRssKiB('4 1 500', 42)).toBe(0);
  });
});
