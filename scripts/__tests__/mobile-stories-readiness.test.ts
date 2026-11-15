import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ wait: vi.fn(), sleep: vi.fn() }));
vi.mock('../lib/metro-dev-server', () => ({
  DEFAULT_METRO_PORT: 8081,
  METRO_PORT: 8081,
  METRO_LOG_PATH: '/tmp/unused',
  metroLogPathForPort: () => '/tmp/unused',
  waitForMetroLogLine: mocks.wait,
  readMetroLogSince: (offset: number, path: string) => readFileSync(path).subarray(offset).toString('utf8'),
}));
vi.mock('../lib/exec', () => ({ sleepSeconds: mocks.sleep }));
import { settleAfterStory, storyRoute } from '../lib/mobile-stories';

let directory: string;
let logPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'story-readiness-'));
  logPath = join(directory, 'metro.log');
  writeFileSync(logPath, '');
  mocks.wait.mockReset();
  mocks.sleep.mockReset();
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('visual captures require readiness evidence', () => {
  it('refuses a missing log instead of sleeping and taking an unverified image', () => {
    expect(() => settleAfterStory('sample--loaded', join(directory, 'absent.log'), 0, 2, '[shots]')).toThrow(
      /cannot verify/,
    );
    expect(mocks.sleep).not.toHaveBeenCalled();
  });
  it.each([
    [null, /did not report readiness/],
    ['[stories] missing sample--loaded', /No story/],
    ['[stories] error sample--loaded Missing image', /Missing image/],
    ['[stories] scenario sample--loaded -> /climbs', /capture a view story/],
  ])('rejects incomplete or failed capture evidence: %s', (line, message) => {
    mocks.wait.mockReturnValue(line);
    expect(() => settleAfterStory('sample--loaded', logPath, 10, 2, '[shots]')).toThrow(message);
    expect(mocks.sleep).not.toHaveBeenCalled();
  });
  it.each(['same batch', 'settle interval'])('rejects errors after ready in the %s', (timing) => {
    const ready = '[stories] ready sample--loaded\n';
    const failed = ready + '[stories] error sample--loaded Missing image\n';
    mocks.wait.mockReturnValue(ready.trim());
    writeFileSync(logPath, timing === 'same batch' ? failed : ready);
    if (timing === 'settle interval') mocks.sleep.mockImplementation(() => writeFileSync(logPath, failed));
    expect(() => settleAfterStory('sample--loaded', logPath, 0, 2, '[shots]')).toThrow('Missing image');
  });
  it('ignores errors before the current capture offset', () => {
    const previous = '[stories] error sample--loaded Previous capture\n';
    writeFileSync(logPath, previous + '[stories] ready sample--loaded\n');
    mocks.wait.mockReturnValue('[stories] ready sample--loaded');
    expect(() => settleAfterStory('sample--loaded', logPath, Buffer.byteLength(previous), 2, '[shots]')).not.toThrow();
  });
  it('allows capture after the requested view reports its paint', () => {
    mocks.wait.mockReturnValue('[stories] ready sample--loaded');
    expect(() => settleAfterStory('sample--loaded', logPath, 10, 2, '[shots]')).not.toThrow();
    expect(mocks.sleep).toHaveBeenCalledWith(0.5);
  });
});

it('preserves renderer selection in the capture deep link', () => {
  expect(storyRoute({ id: 'player--preview', theme: 'dark', variant: 'material', renderMode: 'classic' }, 123)).toBe(
    'dev/stories/player--preview?theme=dark&variant=material&renderMode=classic&shot=123',
  );
});
