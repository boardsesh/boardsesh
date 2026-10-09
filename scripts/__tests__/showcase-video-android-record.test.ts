import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SHOWCASE_WORK_ROOT,
  footageFramePath,
  isShowcasePlatform,
  showcaseWorkDirs,
} from '../lib/showcase-video/contract';
import {
  SCREENRECORD_MAX_SECONDS,
  SHOWCASE_ANDROID_DEVICE,
  SHOWCASE_ANDROID_PACKAGE,
  SNOOZE_SYSTEM_NOTIFICATIONS_SCRIPT,
  androidDevClientUrl,
  androidSerial,
  buildConcatArgs,
  buildConcatList,
  buildDemoModeCommands,
  buildDemoModeExitCommand,
  buildEmulatorArgs,
  buildScreenrecordArgs,
  buildSnoozeSystemNotificationsArgs,
  isScreenrecordStartedLine,
  screenrecordRemotePath,
  showcaseAvdConfig,
  showcaseSystemImage,
} from '../lib/showcase-video/android';
import { anchorTapValues, macOsOnlyMessage, parseRecordArgs, recordRunMode } from '../lib/showcase-video/record';
import {
  SHOWCASE_TAKES,
  findShowcaseTake,
  isShowcaseFlow,
  showcaseFlowPathFor,
  takeForPlatform,
} from '../lib/showcase-video/takes';

const FLOW_DIR = resolve(import.meta.dirname, '../../packages/mobile/.maestro/showcase');

describe('work dirs per platform', () => {
  it('keeps the iOS paths where they were and nests Android under work/android', () => {
    expect(showcaseWorkDirs('ios').footage).toBe(resolve(SHOWCASE_WORK_ROOT, 'work', 'footage'));
    expect(showcaseWorkDirs().anchors).toBe(resolve(SHOWCASE_WORK_ROOT, 'work', 'anchors'));
    const android = showcaseWorkDirs('android');
    expect(android.raw).toBe(resolve(SHOWCASE_WORK_ROOT, 'work', 'android', 'raw'));
    expect(android.footage).toBe(resolve(SHOWCASE_WORK_ROOT, 'work', 'android', 'footage'));
    expect(android.anchors).toBe(resolve(SHOWCASE_WORK_ROOT, 'work', 'android', 'anchors'));
    expect(android.marks).toBe(resolve(SHOWCASE_WORK_ROOT, 'work', 'android', 'marks'));
  });

  it('numbers frames from 00001 in the platform footage dir', () => {
    expect(footageFramePath('spray', 0)).toBe(resolve(SHOWCASE_WORK_ROOT, 'work', 'footage', 'spray', '00001.jpg'));
    expect(footageFramePath('spray', 41, 'android')).toBe(
      resolve(SHOWCASE_WORK_ROOT, 'work', 'android', 'footage', 'spray', '00042.jpg'),
    );
  });

  it('knows its platforms', () => {
    expect(isShowcasePlatform('ios')).toBe(true);
    expect(isShowcasePlatform('android')).toBe(true);
    expect(isShowcasePlatform('web')).toBe(false);
    expect(isShowcasePlatform(undefined)).toBe(false);
  });
});

describe('flows per platform', () => {
  it('prefers showcase/android/<flow> when it exists, else the shared flow', () => {
    const only = (path: string) => (candidate: string) => candidate === path;
    const androidSpray = resolve(FLOW_DIR, 'android', 'spray.yaml');
    expect(showcaseFlowPathFor('spray.yaml', 'android', only(androidSpray))).toBe(androidSpray);
    expect(showcaseFlowPathFor('crew-join.yaml', 'android', only(androidSpray))).toBe(
      resolve(FLOW_DIR, 'crew-join.yaml'),
    );
    expect(showcaseFlowPathFor('spray.yaml', 'ios', only(androidSpray))).toBe(resolve(FLOW_DIR, 'spray.yaml'));
  });

  it('has an Android flow, under the dev-client package, for every step the Android primary runs', () => {
    for (const entry of SHOWCASE_TAKES.map((take) => takeForPlatform(take, 'android'))) {
      const primaryFlows = [entry.flow, ...entry.setupFlows, ...entry.teardownFlows, ...entry.deviceSetupFlows];
      if (entry.privateSession) primaryFlows.push('session-private.yaml');
      for (const flow of primaryFlows.filter(isShowcaseFlow)) {
        const path = resolve(FLOW_DIR, 'android', flow);
        expect(existsSync(path), `${entry.id}: ${flow}`).toBe(true);
      }
    }
  });
});

describe('takeForPlatform', () => {
  it('returns the iOS entry untouched on iOS', () => {
    const crew = findShowcaseTake('crew');
    expect(takeForPlatform(crew, 'ios')).toBe(crew);
  });

  it('lays the Android overrides over the entry', () => {
    const crew = takeForPlatform(findShowcaseTake('crew'), 'android');
    expect(crew.setupFlows).toEqual(['crew-start.yaml', 'crew-invite.yaml']);
    expect(crew.secondary).toEqual(findShowcaseTake('crew').secondary);
    const island = takeForPlatform(findShowcaseTake('lock-screen'), 'android');
    expect(island.deviceSetupFlows).toEqual([]);
    expect(island.setupFlows).toEqual(['lock-screen-setup.yaml', 'lock-screen-arm.yaml']);
    expect(new Set(island.staticAnchors.map((anchor) => anchor.name))).toEqual(
      new Set(['lock-relight', 'lock-mirror', 'lock-next']),
    );
    // Next adds "Previous": the buttons right of it move at the tap.
    const nextRects = island.staticAnchors.filter((anchor) => anchor.name === 'lock-next');
    expect(nextRects.map((anchor) => anchor.fromMark)).toEqual(['island-expanded', 'next-tapped']);
    expect(nextRects[1].rect.x).toBeGreaterThan(nextRects[0].rect.x);
    for (const anchor of island.staticAnchors) {
      expect(anchor.rect.width).toBeGreaterThan(0);
      expect(anchor.rect.x + anchor.rect.width).toBeLessThanOrEqual(SHOWCASE_ANDROID_DEVICE.screen.width);
      expect(anchor.rect.y + anchor.rect.height).toBeLessThanOrEqual(SHOWCASE_ANDROID_DEVICE.screen.height);
    }
  });

  it('marks a take the platform cannot film unavailable on both backends', () => {
    const spray = findShowcaseTake('spray');
    const blocked = takeForPlatform({ ...spray, platforms: { android: { unavailable: 'no reason' } } }, 'android');
    expect(blocked.unavailable).toEqual({ local: 'no reason', prod: 'no reason' });
  });
});

describe('Android emulator', () => {
  it('is a 1080x2424 phone at 420 dpi, 411x923 dp', () => {
    const { lcd, screen } = SHOWCASE_ANDROID_DEVICE;
    expect(Math.round(lcd.width / (lcd.density / 160))).toBe(screen.width);
    expect(Math.round(lcd.height / (lcd.density / 160))).toBe(screen.height);
    expect(androidSerial(SHOWCASE_ANDROID_DEVICE.port)).toBe('emulator-5580');
  });

  it('picks the system image for the host', () => {
    expect(showcaseSystemImage('arm64')).toBe('system-images;android-36;google_apis;arm64-v8a');
    expect(showcaseSystemImage('x64', 35)).toBe('system-images;android-35;google_apis;x86_64');
  });

  it('rewrites the AVD config keys it owns and appends the missing ones', () => {
    const config = showcaseAvdConfig('hw.lcd.width=1080\nhw.lcd.height=2400\nhw.keyboard=yes\nabi.type=arm64-v8a\n');
    const lines = config.trim().split('\n');
    expect(lines).toContain('hw.lcd.height=2424');
    expect(lines).toContain('hw.lcd.density=420');
    expect(lines).toContain('hw.keyboard=no');
    expect(lines).toContain('abi.type=arm64-v8a');
    expect(lines.filter((line) => line.startsWith('hw.lcd.width='))).toEqual(['hw.lcd.width=1080']);
    expect(showcaseAvdConfig(config)).toBe(config);
  });

  it('reads a config.ini with Windows line endings without doubling its keys', () => {
    const config = showcaseAvdConfig('hw.lcd.height=2400\r\nhw.keyboard=yes\r\nabi.type=arm64-v8a\r\n');
    const lines = config.trim().split('\n');
    expect(lines.filter((line) => line.startsWith('hw.lcd.height='))).toEqual(['hw.lcd.height=2424']);
    expect(lines.filter((line) => line.startsWith('hw.keyboard='))).toEqual(['hw.keyboard=no']);
    expect(config).not.toContain('\r');
  });

  it('boots headless in UTC unless asked for a window', () => {
    const args = buildEmulatorArgs({ avdName: 'Boardsesh_Showcase', port: 5580, windowed: false });
    expect(args.slice(0, 6)).toEqual(['-avd', 'Boardsesh_Showcase', '-port', '5580', '-timezone', 'UTC']);
    expect(args).toContain('-no-window');
    expect(args).toContain('-no-snapshot');
    expect(buildEmulatorArgs({ avdName: 'X', port: 5580, windowed: true })).not.toContain('-no-window');
  });

  it('opens the dev client on Metro through localhost', () => {
    expect(androidDevClientUrl(8081)).toBe(
      'exp+boardsesh://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081',
    );
    expect(SHOWCASE_ANDROID_PACKAGE).toBe('com.boardsesh.app.dev');
  });
});

describe('screenrecord', () => {
  it('records at 12 Mbit/s, capped at 180 s per part', () => {
    expect(buildScreenrecordArgs('emulator-5580', '/sdcard/a.mp4')).toEqual([
      '-s',
      'emulator-5580',
      'shell',
      'screenrecord',
      '--verbose',
      '--bit-rate',
      '12000000',
      '--time-limit',
      '180',
      '/sdcard/a.mp4',
    ]);
    expect(buildScreenrecordArgs('s', '/x', 900)).toContain(String(SCREENRECORD_MAX_SECONDS));
    expect(buildScreenrecordArgs('s', '/x', 0)).toContain('1');
    expect(buildScreenrecordArgs('s', '/x', 42.4)).toContain('42');
  });

  it('spots the verbose start line', () => {
    expect(isScreenrecordStartedLine('Main display is 1080x2424 @60.00fps (orientation=ROTATION_0)')).toBe(true);
    expect(isScreenrecordStartedLine('Content area is 1080x2424 at offset x=0 y=0')).toBe(true);
    expect(isScreenrecordStartedLine('Stopping encoder and muxer')).toBe(false);
  });

  it('names the parts and joins them without re-encoding', () => {
    expect(screenrecordRemotePath('spray', 0)).toBe('/sdcard/showcase-spray-00.mp4');
    expect(screenrecordRemotePath('crew', 12)).toBe('/sdcard/showcase-crew-12.mp4');
    expect(buildConcatList(['/a/p0.mp4', "/b/it's.mp4"])).toBe("file '/a/p0.mp4'\nfile '/b/it'\\''s.mp4'\n");
    const args = buildConcatArgs('/a/list.txt', '/a/out.mp4');
    expect(args).toEqual(expect.arrayContaining(['-f', 'concat', '-safe', '0', '-c', 'copy']));
    expect(args.at(-1)).toBe('/a/out.mp4');
  });
});

describe('status bar and shade', () => {
  it('enters demo mode at 09:41 with full bars and no notification icons, and leaves it', () => {
    const commands = buildDemoModeCommands('emulator-5580');
    expect(commands[0]).toEqual([
      '-s',
      'emulator-5580',
      'shell',
      'settings',
      'put',
      'global',
      'sysui_demo_allowed',
      '1',
    ]);
    const flat = commands.map((command) => command.join(' '));
    expect(flat).toContain('-s emulator-5580 shell am broadcast -a com.android.systemui.demo -e command enter');
    expect(flat.some((command) => command.endsWith('-e command clock -e hhmm 0941'))).toBe(true);
    expect(flat.some((command) => command.includes('notifications -e visible false'))).toBe(true);
    expect(buildDemoModeExitCommand('emulator-5580').slice(-2)).toEqual(['command', 'exit']);
  });

  it('snoozes only the system package notifications', () => {
    expect(buildSnoozeSystemNotificationsArgs('emulator-5580')).toEqual([
      '-s',
      'emulator-5580',
      'shell',
      SNOOZE_SYSTEM_NOTIFICATIONS_SCRIPT,
    ]);
    expect(SNOOZE_SYSTEM_NOTIFICATIONS_SCRIPT).toContain("'key=[-0-9]*|android|[^ :]*'");
    expect(SNOOZE_SYSTEM_NOTIFICATIONS_SCRIPT).not.toContain('boardsesh');
  });
});

describe('anchor tap values on the Android screen', () => {
  it('turns an anchor into whole-number percentages of 411x923 dp', () => {
    const values = anchorTapValues(
      { name: 'queue-row-avatar', x: 20, y: 600, width: 40, height: 40 },
      SHOWCASE_ANDROID_DEVICE.screen,
    );
    expect(values).toEqual({
      'anchor-queue-row-avatar-x': '10',
      'anchor-queue-row-avatar-y': '67',
      'anchor-queue-row-avatar-cy': '620',
    });
  });
});

describe('--hold', () => {
  it('parses on either platform', () => {
    expect(parseRecordArgs(['--hold']).hold).toBe(true);
    expect(parseRecordArgs(['--platform', 'android', '--hold'])).toMatchObject({ platform: 'android', hold: true });
    expect(parseRecordArgs([]).hold).toBe(false);
  });

  it('halts before any take or stray-session end once the devices are ready', () => {
    const session = '667186b5-f0e5-4f56-92bf-8646f87d3f81';
    expect(recordRunMode({ hold: true, endSession: null })).toBe('hold');
    expect(recordRunMode({ hold: true, endSession: session })).toBe('hold');
    expect(recordRunMode({ hold: false, endSession: session })).toBe('end-session');
    expect(recordRunMode({ hold: false, endSession: null })).toBe('record');
    expect(recordRunMode(parseRecordArgs(['--platform', 'android', '--hold']))).toBe('hold');
  });
});

describe('off macOS', () => {
  it('says why each platform still needs a Mac', () => {
    expect(macOsOnlyMessage('ios')).toMatch(/drives iOS simulators: macOS only/);
    expect(macOsOnlyMessage('android')).toMatch(/needs macOS on Android too/);
    expect(macOsOnlyMessage('android')).toMatch(/second participant is an iOS simulator/);
  });
});
