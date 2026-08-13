import { describe, it, expect } from 'vitest';
import { resolveSnapshotDownloadStrategy } from '../download-strategy';

const resolve = (
  taskApiFlag: boolean | undefined,
  backgroundSessionFlag: boolean | undefined,
  platform: string,
): string => resolveSnapshotDownloadStrategy({ taskApiFlag, backgroundSessionFlag, platform });

describe('resolveSnapshotDownloadStrategy', () => {
  it('resolves an UNSET task-api flag to the shipped path on both platforms, whatever the other flag says', () => {
    // The corner that matters most: the flag key does not exist in PostHog on
    // OTA day, so `undefined` is what every device reads. It must never reach a
    // transport nobody has run on a real phone.
    for (const backgroundSessionFlag of [undefined, true, false]) {
      expect(resolve(undefined, backgroundSessionFlag, 'ios')).toBe('download-file-async');
      expect(resolve(undefined, backgroundSessionFlag, 'android')).toBe('download-file-async');
    }
  });

  it('resolves an explicitly-off task-api flag to the shipped path everywhere', () => {
    for (const backgroundSessionFlag of [undefined, true, false]) {
      expect(resolve(false, backgroundSessionFlag, 'ios')).toBe('download-file-async');
      expect(resolve(false, backgroundSessionFlag, 'android')).toBe('download-file-async');
    }
  });

  it('gives iOS a background URLSession when the task API is on and the session flag is not explicitly off', () => {
    expect(resolve(true, undefined, 'ios')).toBe('task-background');
    expect(resolve(true, true, 'ios')).toBe('task-background');
  });

  it('pins iOS to a foreground session when the background-session flag is explicitly off', () => {
    expect(resolve(true, false, 'ios')).toBe('task-foreground');
  });

  it('never reports a background session on Android — the native side ignores sessionType', () => {
    for (const backgroundSessionFlag of [undefined, true, false]) {
      expect(resolve(true, backgroundSessionFlag, 'android')).toBe('task-foreground');
    }
  });

  it('never yields task-background for an unknown platform string', () => {
    for (const backgroundSessionFlag of [undefined, true, false]) {
      expect(resolve(true, backgroundSessionFlag, 'web')).toBe('task-foreground');
      expect(resolve(true, backgroundSessionFlag, 'windows')).toBe('task-foreground');
    }
  });
});
