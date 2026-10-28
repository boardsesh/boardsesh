import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

import {
  IOS_DUO_SCREENSHOT_DEVICES,
  IOS_SCREENSHOT_DEVICES,
  IOS_STORE_SCREENSHOT_DEVICES,
  deviceSlug,
  iosSourceFlowFile,
  isDuoScreenshotDevice,
  parseArgs,
  pickIosRuntime,
  splitDuoInnerFlow,
  usesDuoStoreFlow,
} from '../mobile-screenshots';
import {
  DUO_DISPLAY_FOR_POSE,
  duoHingeCompileArgs,
  isUnlitBmp,
  poseFromLitDisplays,
  simulatorArch,
  springBoardPid,
} from '../lib/ios-duo-hinge';
import {
  ACCEPTED_SIZES,
  EXPECTED_APP_STORE_DEVICE_SLUGS,
  acceptedSizesForFile,
  findOffenders,
} from '../assert-screenshot-dimensions';
import { resolveScreenshotRecipes, screenshotCaptions } from '../lib/screenshot-presentation';

const duo = IOS_DUO_SCREENSHOT_DEVICES[0];
const innerFlow = readFileSync('packages/mobile/.maestro/app-store-duo-inner.yaml', 'utf8');
const outerFlow = readFileSync('packages/mobile/.maestro/app-store-duo.yaml', 'utf8');

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function bmp(pixels: readonly number[][], bitsPerPixel: 24 | 32 = 32): Buffer {
  const bytesPerPixel = bitsPerPixel / 8;
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54, 10);
  header.writeUInt16LE(bitsPerPixel, 28);
  const body = Buffer.alloc(pixels.length * bytesPerPixel);
  pixels.forEach((pixel, index) => {
    for (let channel = 0; channel < bytesPerPixel; channel += 1) body[index * bytesPerPixel + channel] = pixel[channel];
  });
  return Buffer.concat([header, body]);
}

describe('iPhone Duo device inventory', () => {
  it('is in the store matrix and the duo group, but not in the custom product page devices', () => {
    expect(duo).toEqual({
      name: 'iPhone Duo',
      typeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo',
      orientation: 'PORTRAIT',
    });
    expect(IOS_STORE_SCREENSHOT_DEVICES).toContain(duo);
    expect(IOS_SCREENSHOT_DEVICES).not.toContain(duo);
    expect(parseArgs(['--devices', 'duo']).devices).toEqual(['iPhone Duo']);
    expect(parseArgs(['--devices', 'common']).devices).toContain('iPhone Duo');
    expect(deviceSlug(duo.name)).toBe('iphone-duo');
    expect(isDuoScreenshotDevice(duo)).toBe(true);
    expect(isDuoScreenshotDevice(IOS_SCREENSHOT_DEVICES[0])).toBe(false);
  });

  it('runs the two-pass store flow for app-store captures only, never for custom product pages', () => {
    const options = parseArgs(['--flow', 'app-store', '--device', 'iPhone Duo']);
    expect(usesDuoStoreFlow(options, duo)).toBe(true);
    expect(iosSourceFlowFile(options, duo)).toMatch(/app-store-duo\.yaml$/);
    const campaign = parseArgs(['--flow', 'app-store-campaign', '--device', 'iPhone Duo']);
    expect(iosSourceFlowFile(campaign, duo)).toMatch(/app-store-duo\.yaml$/);
    const onboarding = parseArgs(['--flow', 'onboarding', '--device', 'iPhone Duo']);
    expect(usesDuoStoreFlow(onboarding, duo)).toBe(false);
    expect(usesDuoStoreFlow({ ...options, cpp: 'kilter' }, duo)).toBe(false);
    expect(usesDuoStoreFlow(options, IOS_SCREENSHOT_DEVICES[0])).toBe(false);
  });

  it('creates the simulator on a runtime that lists the device type', () => {
    const runtimes = [
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
        version: '26.5',
        supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max' }],
      },
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-1',
        version: '27.1',
        supportedDeviceTypes: [{ identifier: duo.typeId }],
      },
    ];
    expect(pickIosRuntime(runtimes, duo.typeId)).toBe('com.apple.CoreSimulator.SimRuntime.iOS-27-1');
    expect(pickIosRuntime(runtimes, 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max')).toBe(
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    );
    expect(
      pickIosRuntime([{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', version: '27.0' }], duo.typeId),
    ).toBe('com.apple.CoreSimulator.SimRuntime.iOS-27-0');
    expect(pickIosRuntime([{ ...runtimes[1], isAvailable: false }], duo.typeId)).toBeNull();
  });
});

describe('Duo Maestro flows', () => {
  it('splits the inner flow into one Maestro flow per shot, relaunching only for the second wall', () => {
    const shots = splitDuoInnerFlow(innerFlow);
    expect(shots.map((shot) => shot.name)).toEqual([
      '00-board-view',
      '03-home',
      '04-playlist-detail',
      '02-climbs',
      '01-board-view-2',
    ]);
    expect(shots.map((shot) => shot.relaunch)).toEqual([false, false, false, false, true]);
    for (const shot of shots) {
      const documents = parseAllDocuments(shot.flow);
      expect(documents.map((document) => document.errors)).toEqual([[], []]);
      expect(documents[0].toJS()).toMatchObject({ appId: 'com.boardsesh.app' });
      expect(shot.flow).not.toMatch(/^- takeScreenshot/m);
      expect(shot.flow).toContain('- openLink: com.boardsesh.app://');
      // A swallowed deep link must fail the shot, never capture the dialog.
      expect(shot.flow).toContain("notVisible: 'Open'");
      // Every open shot waits for a lit climb in the board pane.
      expect(shot.flow).toContain("id: '^cpp-climb-painted-.+$'");
    }
    // Each list screen waits on an id only it has.
    const byName = Object.fromEntries(shots.map((shot) => [shot.name, shot.flow]));
    expect(byName['02-climbs']).toContain("id: 'climbs-screen'");
    expect(byName['03-home']).toContain("id: 'session-feed-card'");
    expect(byName['04-playlist-detail']).toContain("id: 'playlist-add-to-queue'");
  });

  it('keeps coordinate, swipe and text gestures out of the inner flow', () => {
    const commands = innerFlow.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    for (const forbidden of ['tapOn', 'swipe', 'point:', 'scroll', 'setOrientation'])
      expect(commands.join('\n')).not.toContain(forbidden);
  });

  it('shoots the closed pass after priming the Open dialog, numbered after the open shots', () => {
    expect(outerFlow.indexOf("text: 'Open'")).toBeLessThan(outerFlow.indexOf('takeScreenshot'));
    expect([...outerFlow.matchAll(/^- takeScreenshot: (\S+)$/gm)].map((match) => match[1])).toEqual([
      '05-profile',
      '06-session-detail',
      '07-workout-generator',
    ]);
    expect(outerFlow).not.toMatch(/swipe|point:/);
  });

  it('rejects a flow with commands after its last screenshot', () => {
    expect(() =>
      splitDuoInnerFlow('appId: x\n---\n- openLink: a://b\n- takeScreenshot: one\n- openLink: a://c\n'),
    ).toThrow('after its last takeScreenshot');
    expect(() => splitDuoInnerFlow('appId: x\n---\n- takeScreenshot: one\n')).toThrow('has no commands');
  });
});

describe('Duo store set', () => {
  const captureNames = [
    ...splitDuoInnerFlow(innerFlow).map((shot) => `${shot.name}.png`),
    ...[...outerFlow.matchAll(/^- takeScreenshot: (\S+)$/gm)].map((match) => `${match[1]}.png`),
  ];

  it('is eight images, inner shots first, each captioned on its own frame', () => {
    expect(captureNames.length).toBeLessThanOrEqual(10);
    expect([...captureNames].sort()).toEqual(Object.keys(screenshotCaptions('ios', 'iphone-duo')).sort());
    const recipes = resolveScreenshotRecipes('ios', 'iphone-duo', captureNames);
    expect(recipes.map((recipe) => recipe.output)).toEqual([...captureNames].sort());
    expect(recipes.every((recipe) => recipe.layout === 'screen' && recipe.sources.length === 1)).toBe(true);
  });

  it('accepts both displays in the dimension gate and nothing else', () => {
    expect(EXPECTED_APP_STORE_DEVICE_SLUGS).toContain('iphone-duo');
    const files = [
      { name: 'en-US/iphone-duo/00-board-view.png', buffer: pngHeader(2853, 2007) },
      { name: 'en-US/iphone-duo/05-profile.png', buffer: pngHeader(1398, 2034) },
    ];
    expect(findOffenders('iphone-duo', files)).toEqual([]);
    expect(findOffenders('iphone-duo', [{ name: 'phone.png', buffer: pngHeader(1320, 2868) }])).toHaveLength(1);
    expect(ACCEPTED_SIZES['iphone-duo']).toEqual([
      { width: 2853, height: 2007 },
      { width: 1398, height: 2034 },
    ]);
  });

  it('pins each Duo filename to its own display and orientation', () => {
    for (const name of captureNames) {
      const sizes = acceptedSizesForFile('iphone-duo', `en-US/iphone-duo/${name}`);
      expect(sizes).toEqual(name < '05-' ? [{ width: 2853, height: 2007 }] : [{ width: 1398, height: 2034 }]);
    }
    // An outer capture in an inner slot, an inner one in an outer slot, a
    // portrait inner display and a landscape outer display all fail.
    const swapped = [
      { name: 'en-US/iphone-duo/00-board-view.png', buffer: pngHeader(1398, 2034) },
      { name: 'en-US/iphone-duo/06-session-detail.png', buffer: pngHeader(2853, 2007) },
      { name: 'en-US/iphone-duo/02-climbs.png', buffer: pngHeader(2007, 2853) },
      { name: 'en-US/iphone-duo/07-workout-generator.png', buffer: pngHeader(2034, 1398) },
    ];
    expect(findOffenders('iphone-duo', swapped).map((offender) => offender.file)).toEqual(
      swapped.map((file) => file.name),
    );
    // A file outside the 00-07 slots has no size at all.
    expect(
      findOffenders('iphone-duo', [{ name: 'en-US/iphone-duo/08-extra.png', buffer: pngHeader(2853, 2007) }]),
    ).toEqual([
      { file: 'en-US/iphone-duo/08-extra.png', reason: 'matches 0 filename size rules for device "iphone-duo"' },
    ]);
    // Other devices keep their per-device lists.
    expect(acceptedSizesForFile('iphone-16-pro', 'x/00-home.png')).toEqual(ACCEPTED_SIZES['iphone-16-pro']);
    expect(acceptedSizesForFile('iphone-99', 'x/00-home.png')).toBe('no accepted-size list for device "iphone-99"');
  });
});

describe('Duo hinge helper', () => {
  it('compiles the SpringBoard library for the host simulator architecture', () => {
    expect(simulatorArch('arm64')).toBe('arm64');
    expect(simulatorArch('x64')).toBe('x86_64');
    const args = duoHingeCompileArgs('in.m', 'out.dylib', 'arm64');
    expect(args.slice(0, 3)).toEqual(['-sdk', 'iphonesimulator', 'clang']);
    expect(args).toContain('-dynamiclib');
    expect(args.slice(-3)).toEqual(['in.m', '-o', 'out.dylib']);
  });

  it("finds SpringBoard's pid in the simulator's launchctl list", () => {
    const list =
      'PID\tStatus\tLabel\n12\t0\tcom.apple.backboardd\n4242\t-9\tcom.apple.SpringBoard\n-\t0\tcom.apple.SpringBoard.extra\n';
    expect(springBoardPid(list)).toBe(4242);
    expect(springBoardPid('-\t0\tcom.apple.SpringBoard\n')).toBeNull();
  });

  it('tells a dark display from a lit one, ignoring alpha', () => {
    expect(
      isUnlitBmp(
        bmp([
          [0, 0, 0, 255],
          [3, 2, 1, 255],
        ]),
      ),
    ).toBe(true);
    expect(
      isUnlitBmp(
        bmp([
          [0, 0, 0, 255],
          [0, 40, 0, 255],
        ]),
      ),
    ).toBe(false);
    expect(
      isUnlitBmp(
        bmp(
          [
            [0, 0, 0],
            [0, 0, 0],
          ],
          24,
        ),
      ),
    ).toBe(true);
    expect(() => isUnlitBmp(Buffer.from('not a bitmap at all, just some bytes long enough to read'))).toThrow();
  });

  it('reads the pose from which display is lit', () => {
    expect(poseFromLitDisplays(true, false)).toBe('closed');
    expect(poseFromLitDisplays(false, true)).toBe('open');
    expect(poseFromLitDisplays(false, false)).toBeNull();
    expect(poseFromLitDisplays(true, true)).toBeNull();
    expect(DUO_DISPLAY_FOR_POSE).toEqual({ closed: 'primary', open: 'primary-1' });
  });
});
