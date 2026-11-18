import { describe, expect, it } from 'vitest';
import { parseLabParams, slowdownForSpeed } from '../params';

describe('parseLabParams', () => {
  it('reads every param', () => {
    expect(
      parseLabParams({
        variant: 'wipe',
        board: 'kb',
        set: 'half',
        speed: '0.25',
        autoplay: 'all',
        reduceMotion: 'on',
        preset: 'Bold',
      }),
    ).toEqual({
      variant: 'wipe',
      board: 'kb',
      set: 'half',
      speed: 0.25,
      autoplay: 'all',
      reduceMotion: 'on',
      preset: 'bold',
    });
  });
  it('nulls anything unrecognised', () => {
    expect(parseLabParams({ speed: '3', reduceMotion: 'maybe', variant: '' })).toEqual({
      variant: null,
      board: null,
      set: null,
      speed: null,
      autoplay: null,
      reduceMotion: null,
      preset: null,
    });
  });
  it('takes the first of repeated params and accepts 0.5x', () => {
    expect(parseLabParams({ speed: ['0.5x', '1'] }).speed).toBe(0.5);
  });
  it('maps speed to slowdown', () => {
    expect([1, 0.5, 0.25].map((speed) => slowdownForSpeed(speed as 1 | 0.5 | 0.25))).toEqual([1, 2, 4]);
  });
});
