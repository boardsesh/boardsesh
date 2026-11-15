import { describe, expect, it } from 'vitest';
import { migrateCaptureRoute } from '../lib/retired-capture';

describe('retired production screenshot commands', () => {
  it.each([
    ['board-view', 'player--lit'],
    ['board-sheet', 'board-selector--populated'],
    ['session-detail', 'workout-server-data--detail'],
    ['logbook', 'logbook--populated'],
    ['progress', 'progress--overview'],
  ])('migrates %s to an isolated story', (route, story) => {
    const options = { to: route as string | null, story: null as string | null };
    migrateCaptureRoute(options);
    expect(options).toEqual({ to: null, story });
  });
  it('rejects raw production screenshot query commands', () => {
    expect(() => migrateCaptureRoute({ to: 'climbs?screenshotDrive=1', story: null })).toThrow('Use --story');
  });
  it('leaves ordinary application routes alone', () => {
    const options = { to: 'home', story: null };
    migrateCaptureRoute(options);
    expect(options.to).toBe('home');
  });
});
