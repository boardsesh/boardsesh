import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  METRO_LOG_PATH,
  isIosBundledLine,
  metroLogOffset,
  metroLogPathForPort,
  metroProcessEnv,
  readMetroLogSince,
  shotsMetroWatch,
  waitForMetroLogLine,
} from '../lib/metro-dev-server';
import { assertStoryId, findStoryLogEvent, resolveMetroLogPath, storyRoute } from '../lib/mobile-stories';
import { parseShotsArgs as parseAndroidShotsArgs } from '../mobile-android-shots';
import { parseShotsArgs, portAppIsCurrent, portAppPath } from '../mobile-ios-shots';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boardsesh-shots-stories-'));
  tempDirs.push(dir);
  return dir;
}

describe('mobile-ios-shots --story', () => {
  it('opens the story route and labels the shot with the id', () => {
    const options = parseShotsArgs(['screenshot', '--story', 'crew-browse--pills']);
    expect(options.command).toBe('screenshot');
    expect(options.to).toBe('dev/stories/crew-browse--pills');
    expect(options.label).toBe('crew-browse--pills');
  });

  it('appends --theme and --variant as query params and to the label', () => {
    const options = parseShotsArgs(['--', '--story', 'wall-state', '--theme', 'light', '--variant', 'material']);
    expect(options.command).toBe('run');
    expect(options.to).toBe('dev/stories/wall-state?theme=light&variant=material');
    expect(options.label).toBe('wall-state-light-material');
  });

  it('keeps an explicit --label', () => {
    expect(parseShotsArgs(['navigate', '--story', 'wall-state', '--label', 'mine']).label).toBe('mine');
  });

  it('produces a route the deep-link allowlist accepts', () => {
    const { to } = parseShotsArgs(['--story', 'a1--b-2', '--theme', 'dark', '--variant', 'liquidGlass']);
    expect(to).toMatch(/^[A-Za-z0-9?=&_.:/%-]+$/);
  });

  it('rejects bad ids and values', () => {
    expect(() => parseShotsArgs(['--story', 'Crew_Browse'])).toThrow(/story id/);
    expect(() => parseShotsArgs(['--story', 'crew"; rm'])).toThrow(/story id/);
    expect(() => parseShotsArgs(['--story', '-crew'])).toThrow(/story id/);
    expect(() => parseShotsArgs(['--story', '--theme'])).toThrow(/requires a value/);
    expect(() => parseShotsArgs(['--story', 'crew-'])).toThrow(/story id/);
    expect(() => parseShotsArgs(['--story', 'crew', '--theme', 'system'])).toThrow(
      /--theme must be one of: dark, light/,
    );
    expect(() => parseShotsArgs(['--story', 'crew', '--variant', 'auto'])).toThrow(
      /--variant must be one of: liquidGlass, material/,
    );
  });

  it('refuses --story with --to, and --theme/--variant without --story', () => {
    expect(() => parseShotsArgs(['--story', 'crew', '--to', 'climbs'])).toThrow(/not both/);
    expect(() => parseShotsArgs(['--to', 'climbs', '--theme', 'dark'])).toThrow(/need --story/);
    expect(() => parseShotsArgs(['--variant', 'material'])).toThrow(/need --story/);
  });

  it('watches while holding Metro, not for a --shutdown one-shot, unless told', () => {
    expect(shotsMetroWatch(parseShotsArgs([]))).toBe(true);
    expect(shotsMetroWatch(parseShotsArgs(['--shutdown']))).toBe(false);
    expect(shotsMetroWatch(parseShotsArgs(['--shutdown', '--watch']))).toBe(true);
    expect(shotsMetroWatch(parseShotsArgs(['--no-watch']))).toBe(false);
  });

  it('resolves --metro-log to an absolute path', () => {
    expect(parseShotsArgs(['screenshot', '--metro-log', 'metro.log']).metroLog).toMatch(/^\/.*\/metro\.log$/);
  });
});

describe('mobile-android-shots --story', () => {
  it('mirrors the iOS route, label and validation', () => {
    const options = parseAndroidShotsArgs(['screenshot', '--story', 'wall-state--lit', '--theme', 'dark']);
    expect(options.to).toBe('dev/stories/wall-state--lit?theme=dark');
    expect(options.label).toBe('wall-state--lit-dark');
    expect(() => parseAndroidShotsArgs(['--theme', 'dark'])).toThrow(/need --story/);
    expect(shotsMetroWatch(parseAndroidShotsArgs([]))).toBe(true);
    expect(shotsMetroWatch(parseAndroidShotsArgs(['--shutdown']))).toBe(false);
  });
});

describe('story helpers', () => {
  it('builds the bare route without a query', () => {
    expect(storyRoute({ id: 'crew-browse--empty', theme: null, variant: null })).toBe('dev/stories/crew-browse--empty');
    expect(assertStoryId('reset')).toBe('reset');
  });

  it('finds the ready line for an exact id, and for a bare module id', () => {
    const log = ' LOG  [stories] ready crew-browse--empty\n';
    expect(findStoryLogEvent(log, 'crew-browse--empty')).toEqual({ kind: 'ready', storyId: 'crew-browse--empty' });
    expect(findStoryLogEvent(log, 'crew-browse')).toEqual({ kind: 'ready', storyId: 'crew-browse--empty' });
  });

  it('ignores lines for other stories that share a prefix', () => {
    expect(findStoryLogEvent(' LOG  [stories] ready crew-browse--empty-list\n', 'crew-browse--empty')).toBeNull();
    const otherModules = [' LOG  [stories] ready crew-browse-extra--a', ' LOG  [stories] ready crew--empty'].join('\n');
    expect(findStoryLogEvent(otherModules, 'crew-browse')).toBeNull();
  });

  it('reports a scenario and a missing story', () => {
    expect(findStoryLogEvent(' LOG  [stories] scenario home--offline -> /home\n', 'home--offline')).toEqual({
      kind: 'scenario',
      storyId: 'home--offline',
      route: '/home',
    });
    expect(findStoryLogEvent(' LOG  [stories] missing crew (did you mean crew-browse--empty)\n', 'crew')).toEqual({
      kind: 'missing',
      line: '[stories] missing crew (did you mean crew-browse--empty)',
    });
  });
});

describe('Metro log helpers', () => {
  it('keeps the CI log name on 8081 and gives other ports their own log', () => {
    expect(metroLogPathForPort(8081)).toBe(METRO_LOG_PATH);
    expect(metroLogPathForPort(8087)).toMatch(/boardsesh-screenshot-metro-8087\.log$/);
  });

  it('reads only what was written after the offset, and from the start after a truncation', () => {
    const log = join(makeTempDir(), 'metro.log');
    expect(metroLogOffset(log)).toBe(0);
    expect(readMetroLogSince(0, log)).toBe('');
    writeFileSync(log, 'iOS Bundled 900ms index.ts\n');
    const offset = metroLogOffset(log);
    appendFileSync(log, ' LOG  [stories] ready a--b\n');
    expect(readMetroLogSince(offset, log)).toBe(' LOG  [stories] ready a--b\n');
    writeFileSync(log, 'x\n');
    expect(readMetroLogSince(offset, log)).toBe('x\n');
  });

  it('finds a matching line past the offset, or gives up at the timeout', () => {
    const log = join(makeTempDir(), 'metro.log');
    writeFileSync(log, 'iOS Bundled 900ms index.ts (1 module)\n');
    const offset = metroLogOffset(log);
    expect(waitForMetroLogLine(isIosBundledLine, offset, 0, log)).toBeNull();
    appendFileSync(log, 'iOS Bundled 40ms index.ts (4102 modules)\n');
    expect(waitForMetroLogLine(isIosBundledLine, offset, 0, log)).toBe('iOS Bundled 40ms index.ts (4102 modules)');
    expect(isIosBundledLine('Android Bundled 40ms index.ts')).toBe(false);
  });

  it('prefers --metro-log, then the newest candidate log', () => {
    const root = makeTempDir();
    expect(resolveMetroLogPath('relative.log', root)).toMatch(/^\/.*\/relative\.log$/);
    mkdirSync(join(root, '.boardsesh'));
    const devMobileLog = join(root, '.boardsesh', 'mobile-metro.log');
    writeFileSync(devMobileLog, '');
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    utimesSync(devMobileLog, future, future);
    expect(resolveMetroLogPath(null, root, 8099)).toBe(devMobileLog);
  });

  it('turns watching on by dropping CI and pinning the Tailscale hostname', () => {
    expect(metroProcessEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', CI: '1' });
    expect(metroProcessEnv({ PATH: '/bin', CI: '1' }, true)).toEqual({ PATH: '/bin', TAILSCALE_HOSTNAME: 'localhost' });
    expect(metroProcessEnv({ TAILSCALE_HOSTNAME: 'box.ts.net' }, true)).toEqual({ TAILSCALE_HOSTNAME: 'box.ts.net' });
  });
});

describe('per-port iOS app copy', () => {
  it('lives under ~/.cache, never /tmp', () => {
    expect(portAppPath(8087)).toBe(join(homedir(), '.cache', 'boardsesh', 'ios-shots-apps', '8087', 'Boardsesh.app'));
  });

  it('is reused only for the same source build', () => {
    const stamp = { source: '/apps/Boardsesh.app', sourceMtimeMs: 100 };
    expect(portAppIsCurrent(stamp, '/apps/Boardsesh.app', 100)).toBe(true);
    expect(portAppIsCurrent(stamp, '/apps/Boardsesh.app', 200)).toBe(false);
    expect(portAppIsCurrent(stamp, '/other/Boardsesh.app', 100)).toBe(false);
    expect(portAppIsCurrent(null, '/apps/Boardsesh.app', 100)).toBe(false);
  });
});
