import { describe, it, expect } from 'vitest';
import { resolveSnapshotDownloadStrategy } from '../download-strategy';

describe('resolveSnapshotDownloadStrategy', () => {
  it('always gives iOS a background URLSession task', () => {
    expect(resolveSnapshotDownloadStrategy('ios')).toBe('task-background');
  });

  it('always gives Android the foreground DownloadTask arm', () => {
    expect(resolveSnapshotDownloadStrategy('android')).toBe('task-foreground');
  });

  it('never yields task-background for an unknown platform string', () => {
    expect(resolveSnapshotDownloadStrategy('web')).toBe('task-foreground');
    expect(resolveSnapshotDownloadStrategy('windows')).toBe('task-foreground');
  });
});
