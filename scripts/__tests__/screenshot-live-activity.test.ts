import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { importLiveActivityCapture } from '../import-live-activity-capture';
import { extractLiveActivityExterior } from '../lib/screenshot-live-activity-exterior';
import { frameShowcaseComposition } from '../frame-screenshots';
import {
  readCaptionCatalog,
  readPresentationManifest,
  resolveScreenshotRecipes,
  IOS_CAMPAIGN_CAPTURE_NAMES,
} from '../lib/screenshot-presentation';
import { cppCaptureNames, readCppPage } from '../lib/screenshot-cpp';
import {
  loadLiveActivityFixture,
  loadFullScreenLiveActivityFixture,
  nativeCaptureSha256,
  validateLiveActivityFixture,
  type LiveActivityFixture,
} from '../lib/screenshot-live-activity';

const directories: string[] = [];
const directory = () => {
  const pathname = mkdtempSync(join(tmpdir(), 'native-activity-test-'));
  directories.push(pathname);
  return pathname;
};
afterEach(() => {
  for (const pathname of directories.splice(0)) rmSync(pathname, { recursive: true, force: true });
});

function provenance(): LiveActivityFixture {
  return {
    file: 'kilter-en-US.png',
    sha256: 'a'.repeat(64),
    sourcePngSha256: 'b'.repeat(64),
    boardFamily: 'kilter',
    appLocale: 'en-US',
    widgetLocale: 'en',
    captureSurface: 'notification-center',
    device: 'iPhone13Pro',
    sourceBuild: 'TestFlight2.6.0(18)',
    appSourceCommit: null,
    capturedAt: '2026-10-14T06:30:00Z',
    nativePixels: { width: 1170, height: 2532 },
    screenPoints: { width: 390, height: 844 },
    cropRect: { x: 30, y: 714, width: 1110, height: 435 },
    content: { climbName: 'Orestes', grade: 'V8+', currentIndex: 261, totalClimbs: 262, nextEnabled: true },
    controller: {
      connection: 'real-ble',
      presentedBoardFamily: 'kilter',
      description: 'Unit-test metadata',
      physicalWallLightingVerified: false,
    },
    review: {
      reviewedAt: '2026-10-14T06:35:00Z',
      reviewedBy: 'Unit test',
      nativePixelsUnmodified: true,
      unrelatedNotificationsExcluded: true,
      appLocaleVerified: true,
      nextNavigationVerified: true,
    },
  };
}
async function importedFixture() {
  const root = directory();
  const source = await sharp({ create: { width: 1170, height: 2532, channels: 3, background: '#445566' } })
    .composite([
      {
        input: Buffer.from(
          '<svg width="1110" height="435"><rect width="100%" height="100%" fill="#02030a"/><rect x="1" y="1" width="1108" height="433" rx="95" fill="#0f0b16" stroke="#77727f" stroke-width="2"/><rect x="100" y="100" width="200" height="200" fill="#123456"/></svg>',
        ),
        left: 30,
        top: 714,
      },
    ])
    .png()
    .toBuffer();
  const input = join(root, 'private-source.png');
  const metadata = join(root, 'private-provenance.json');
  writeFileSync(input, source);
  writeFileSync(metadata, JSON.stringify(provenance()));
  const fixture = await importLiveActivityCapture(input, metadata, root);
  return { root, source, fixture };
}

function fullScreenProvenance(): LiveActivityFixture {
  const original = provenance();
  return {
    ...original,
    sha256: original.sourcePngSha256,
    captureFraming: 'full-screen',
    captureSurface: 'lock-screen',
    cropRect: { x: 0, y: 0, ...original.nativePixels },
    lockScreenContext: {
      wallpaper: 'Unit-test photo wallpaper',
      deviceLocked: true,
      unrelatedNotificationsDismissed: true,
      liveActivityRect: original.cropRect,
    },
  };
}

function fullNotificationCenterProvenance(): LiveActivityFixture {
  const { lockScreenContext, ...original } = fullScreenProvenance();
  return {
    ...original,
    captureSurface: 'notification-center',
    notificationCenterContext: {
      wallpaper: lockScreenContext!.wallpaper,
      unrelatedNotificationsDismissed: true,
      liveActivityRect: lockScreenContext!.liveActivityRect,
      entryFromAuthenticatedApp: true,
      authenticationState: 'not-established',
    },
  };
}

describe('reviewed native Live Activity fixtures', () => {
  it('retains a reviewed complete Lock Screen byte-for-byte for CI framing', async () => {
    const root = directory();
    const source = await sharp({ create: { width: 1170, height: 2532, channels: 3, background: '#112233' } })
      .png()
      .toBuffer();
    const input = join(root, 'private-source.png');
    const metadata = join(root, 'private-provenance.json');
    writeFileSync(input, source);
    writeFileSync(metadata, JSON.stringify(fullScreenProvenance()));
    const file = await importLiveActivityCapture(input, metadata, root);
    expect(file).toBe(join(root, 'kilter-en-US-lock-screen.png'));
    const loaded = loadFullScreenLiveActivityFixture('kilter', 'en-US', root);
    expect(loaded.pixels.equals(source)).toBe(true);
    expect(loaded.provenance).toMatchObject({
      captureFraming: 'full-screen',
      captureSurface: 'lock-screen',
      sourcePngSha256: nativeCaptureSha256(source),
      sha256: nativeCaptureSha256(source),
      lockScreenContext: { deviceLocked: true, unrelatedNotificationsDismissed: true },
    });
    expect(loaded.provenance.extraction).toBeUndefined();
    const framed = await frameShowcaseComposition(
      [loaded.pixels],
      readCaptionCatalog('en-US').storeLiveActivity,
      'store-live-activity',
      { outputCanvas: { width: 1206, height: 2622 } },
    );
    expect(await sharp(framed).metadata()).toMatchObject({ width: 1206, height: 2622 });
  });
  it('preserves full Notification Center bytes without asserting passcode lock or direct take entry', async () => {
    const root = directory();
    const source = await sharp({ create: { width: 1170, height: 2532, channels: 3, background: '#112233' } })
      .png()
      .toBuffer();
    const supplied = fullNotificationCenterProvenance();
    const input = join(root, 'source.png');
    const metadata = join(root, 'provenance.json');
    writeFileSync(input, source);
    writeFileSync(metadata, JSON.stringify({ ...supplied, rawWdaLocked: true }));
    expect(await importLiveActivityCapture(input, metadata, root)).toBe(
      join(root, 'kilter-en-US-notification-center.png'),
    );
    const loaded = loadFullScreenLiveActivityFixture('kilter', 'en-US', root);
    expect(loaded.pixels.equals(source)).toBe(true);
    expect(loaded.provenance.notificationCenterContext).toEqual(supplied.notificationCenterContext);
    expect(loaded.provenance.lockScreenContext).toBeUndefined();
    expect(JSON.stringify(loaded.provenance)).not.toMatch(/deviceLocked|rawWdaLocked/);
  });
  it.each([
    { notificationCenterContext: undefined },
    { lockScreenContext: fullScreenProvenance().lockScreenContext },
    { captureSurface: 'lock-screen' },
    { captureFraming: undefined },
    { cropRect: provenance().cropRect },
    {
      notificationCenterContext: {
        ...fullNotificationCenterProvenance().notificationCenterContext,
        deviceLocked: true,
      },
    },
    {
      notificationCenterContext: {
        ...fullNotificationCenterProvenance().notificationCenterContext,
        entryFromAuthenticatedApp: false,
      },
    },
    {
      notificationCenterContext: {
        ...fullNotificationCenterProvenance().notificationCenterContext,
        authenticationState: 'locked',
      },
    },
    {
      notificationCenterContext: {
        ...fullNotificationCenterProvenance().notificationCenterContext,
        unrelatedNotificationsDismissed: false,
      },
    },
    {
      notificationCenterContext: {
        ...fullNotificationCenterProvenance().notificationCenterContext,
        liveActivityRect: { x: 0, y: 2500, width: 100, height: 100 },
      },
    },
  ])('rejects incomplete or falsely locked full Notification Center context %j', (override) => {
    expect(() =>
      validateLiveActivityFixture({ ...fullNotificationCenterProvenance(), ...override }, 'kilter', 'en-US'),
    ).toThrow('Invalid native');
  });
  it.each([
    { captureSurface: 'notification-center' },
    { cropRect: provenance().cropRect },
    { sha256: 'c'.repeat(64) },
    { lockScreenContext: { ...fullScreenProvenance().lockScreenContext, deviceLocked: false } },
    { lockScreenContext: { ...fullScreenProvenance().lockScreenContext, unrelatedNotificationsDismissed: false } },
    { lockScreenContext: { ...fullScreenProvenance().lockScreenContext, wallpaper: '' } },
    {
      lockScreenContext: {
        ...fullScreenProvenance().lockScreenContext,
        liveActivityRect: { x: 30, y: 2400, width: 1110, height: 435 },
      },
    },
  ])('rejects cropped, repainted, unlocked or uncleared full-screen provenance %j', (override) => {
    expect(() => validateLiveActivityFixture({ ...fullScreenProvenance(), ...override }, 'kilter', 'en-US')).toThrow(
      'Invalid native',
    );
  });
  it('crops losslessly and keeps physical identity separate from an App Store canvas', async () => {
    const { root, source } = await importedFixture();
    const loaded = loadLiveActivityFixture('kilter', 'en-US', root);
    const expected = await sharp(source)
      .extract({ left: 30, top: 714, width: 1110, height: 435 })
      .removeAlpha()
      .raw()
      .toBuffer();
    expect((await sharp(loaded.pixels).removeAlpha().raw().toBuffer()).equals(expected)).toBe(true);
    expect(loaded.provenance.extraction).toMatchObject({
      method: 'edge-connected-native-exterior-alpha',
      borderGuardPixels: 1,
    });
    expect(loaded.provenance.sourcePngSha256).toBe(nativeCaptureSha256(source));
    expect(loaded.provenance).toMatchObject({
      appSourceCommit: null,
      device: 'iPhone13Pro',
      sourceBuild: 'TestFlight2.6.0(18)',
      captureSurface: 'notification-center',
    });
    expect(loaded.provenance.cropRect).toEqual({ x: 30, y: 714, width: 1110, height: 435 });
  });
  it('rejects changed pixels and never falls back to a different locale or board', async () => {
    const { root, fixture } = await importedFixture();
    expect(() => loadLiveActivityFixture('kilter', 'es', root)).toThrow('Missing reviewed native');
    expect(() => loadLiveActivityFixture('moonboard', 'en-US', root)).toThrow('Missing reviewed native');
    const pixels = readFileSync(fixture);
    pixels[pixels.length - 1] ^= 1;
    writeFileSync(fixture, pixels);
    expect(() => loadLiveActivityFixture('kilter', 'en-US', root)).toThrow('hash mismatch');
  });
  it('rejects a valid legacy card when a whole-phone recipe requests its matching fixture', async () => {
    const { root } = await importedFixture();
    expect(loadLiveActivityFixture('kilter', 'en-US', root).provenance.captureSurface).toBe('notification-center');
    expect(() => loadFullScreenLiveActivityFixture('kilter', 'en-US', root)).toThrow('complete native system screen');
  });
  it('removes only edge-connected wallpaper, preserving opaque native RGB and its border', async () => {
    const original = readFileSync(
      join(new URL('../../app-stores/apple/live-activity-captures/', import.meta.url).pathname, 'kilter-en-US.png'),
    );
    const extracted = await extractLiveActivityExterior(original);
    const before = await sharp(original).removeAlpha().raw().toBuffer();
    const after = await sharp(extracted.pixels).raw().toBuffer({ resolveWithObject: true });
    expect(after.info.channels).toBe(4);
    let transparent = 0;
    let clippedBorderPixels = 0;
    const unmodifiedRgb = Buffer.alloc(before.length);
    for (let pixel = 0; pixel < 1110 * 435; pixel++) {
      after.data.copy(unmodifiedRgb, pixel * 3, pixel * 4, pixel * 4 + 3);
      if (!after.data[pixel * 4 + 3]) transparent++;
      if (before[pixel * 3] > 3 && after.data[pixel * 4 + 3] !== 255) clippedBorderPixels++;
    }
    expect(unmodifiedRgb.equals(before)).toBe(true);
    expect(clippedBorderPixels).toBe(0);
    expect(transparent).toBe(extracted.extraction.transparentPixels);
    expect(transparent).toBeGreaterThan(2000);
  });
  it('rejects blank or unsupported native outlines instead of inventing a widget shape', async () => {
    const blank = await sharp({ create: { width: 1110, height: 435, channels: 3, background: '#000000' } })
      .png()
      .toBuffer();
    await expect(extractLiveActivityExterior(blank)).rejects.toThrow('outline does not match');
    const unsupported = await sharp(blank).resize(1000, 400).png().toBuffer();
    await expect(extractLiveActivityExterior(unsupported)).rejects.toThrow('measure and review');
  });
  it.each([
    { file: '../escape.png' },
    { appLocale: 'es' },
    { boardFamily: 'moonboard' },
    { cropRect: { x: 30, y: 2400, width: 1110, height: 435 } },
    { controller: { ...provenance().controller, presentedBoardFamily: 'tension' } },
    { review: { ...provenance().review, appLocaleVerified: false } },
    { review: { ...provenance().review, nextNavigationVerified: false } },
    { content: { ...provenance().content, currentIndex: 263 } },
  ])('rejects unsupported or unreviewed provenance %j', (override) => {
    expect(() => validateLiveActivityFixture({ ...provenance(), ...override }, 'kilter', 'en-US')).toThrow(
      'Invalid native',
    );
  });
  it('records actual English widget language on a separately verified Spanish app capture', () => {
    expect(
      validateLiveActivityFixture({ ...provenance(), appLocale: 'es', widgetLocale: 'en' }, 'kilter', 'es'),
    ).toMatchObject({ appLocale: 'es', widgetLocale: 'en' });
  });
  const reviewedAuroraCompatibility = {
    protocol: 'aurora-uart',
    targetBoardFamily: 'tension',
    serialMismatchAccepted: true,
    verification: 'native-next-and-received-led-payload',
  } as const;
  it('preserves the advertised Kilter identity on a reviewed native Tension capture', () => {
    const checked = validateLiveActivityFixture(
      {
        ...provenance(),
        boardFamily: 'tension',
        controller: { ...provenance().controller, compatibility: reviewedAuroraCompatibility },
      },
      'tension',
      'en-US',
    );
    expect(checked.boardFamily).toBe('tension');
    expect(checked.controller).toMatchObject({
      presentedBoardFamily: 'kilter',
      physicalWallLightingVerified: false,
      compatibility: reviewedAuroraCompatibility,
    });
  });
  it.each([
    undefined,
    { ...reviewedAuroraCompatibility, protocol: 'moonboard' },
    { ...reviewedAuroraCompatibility, targetBoardFamily: 'kilter' },
    { ...reviewedAuroraCompatibility, serialMismatchAccepted: false },
    { ...reviewedAuroraCompatibility, verification: 'connection-only' },
  ])('rejects mismatched controller identity without complete Aurora proof %j', (compatibility) => {
    expect(() =>
      validateLiveActivityFixture(
        { ...provenance(), boardFamily: 'tension', controller: { ...provenance().controller, compatibility } },
        'tension',
        'en-US',
      ),
    ).toThrow('Invalid native');
  });
  it('does not turn reviewed controller compatibility into a family fallback or wall-lighting claim', () => {
    for (const boardFamily of ['kilter', 'moonboard'] as const)
      expect(() =>
        validateLiveActivityFixture(
          {
            ...provenance(),
            boardFamily,
            controller: { ...provenance().controller, compatibility: reviewedAuroraCompatibility },
          },
          boardFamily,
          'en-US',
        ),
      ).toThrow('Invalid native');
    expect(() =>
      validateLiveActivityFixture(
        {
          ...provenance(),
          boardFamily: 'tension',
          controller: {
            ...provenance().controller,
            compatibility: reviewedAuroraCompatibility,
            physicalWallLightingVerified: true,
          },
        },
        'tension',
        'en-US',
      ),
    ).toThrow('Invalid native');
  });
  it('strips private capture dumps and unrelated notification metadata before saving provenance', () => {
    const checked = validateLiveActivityFixture(
      {
        ...provenance(),
        rawAccessibility: 'Private notification',
        deviceUdid: 'private',
        cropRect: { ...provenance().cropRect, privatePath: '/private/example' },
        review: { ...provenance().review, rawLabels: ['Private notification'] },
      },
      'kilter',
      'en-US',
    );
    expect(JSON.stringify(checked)).not.toMatch(/Private notification|privatePath|deviceUdid|rawLabels/);
  });
  it('round-trips native source identity separately from the output canvas and rejects relabeling', async () => {
    const { root } = await importedFixture();
    const loaded = loadLiveActivityFixture('kilter', 'en-US', root);
    const manifest = {
      version: 1,
      locale: 'en-US',
      files: {
        '07-live-activity.png': {
          rawBytes: loaded.pixels.length,
          rawSha256: loaded.provenance.sha256,
          framedSha256: 'c'.repeat(64),
          liveActivity: {
            fixture: loaded.provenance,
            manifestSha256: loaded.manifestSha256,
            outputCanvas: { width: 1206, height: 2622 },
          },
        },
      },
    };
    writeFileSync(join(root, 'presentation.json'), JSON.stringify(manifest));
    expect(readPresentationManifest(root).files['07-live-activity.png'].liveActivity).toMatchObject({
      fixture: { device: 'iPhone13Pro', nativePixels: { width: 1170, height: 2532 }, appSourceCommit: null },
      outputCanvas: { width: 1206, height: 2622 },
    });
    manifest.files['07-live-activity.png'].liveActivity.fixture.appLocale = 'es';
    writeFileSync(join(root, 'presentation.json'), JSON.stringify(manifest));
    expect(() => readPresentationManifest(root)).toThrow('Invalid native Live Activity provenance');
  });
  it.each([
    { width: 1206, height: 2622 },
    { width: 1320, height: 2868 },
  ])('frames a physical card on the requested %j output without inventing a source phone', async (outputCanvas) => {
    const { root } = await importedFixture();
    const loaded = loadLiveActivityFixture('kilter', 'en-US', root);
    const framed = await frameShowcaseComposition(
      [loaded.pixels],
      readCaptionCatalog('en-US').storeLiveActivity,
      'store-live-activity',
      { outputCanvas },
    );
    expect(await sharp(framed).metadata()).toMatchObject({ ...outputCanvas, hasAlpha: false });
    expect(loaded.provenance.nativePixels).toEqual({ width: 1170, height: 2532 });
    await expect(
      frameShowcaseComposition([loaded.pixels], readCaptionCatalog('en-US').storeLiveActivity, 'store-live-activity'),
    ).rejects.toThrow('output canvas');
  });
  it('omits unsupported runtime capture while keeping all nine default and Kilter phone recipes', () => {
    expect(IOS_CAMPAIGN_CAPTURE_NAMES).not.toContain('17-dynamic-island.png');
    const recipes = resolveScreenshotRecipes('ios', 'iphone-16-pro', IOS_CAMPAIGN_CAPTURE_NAMES);
    expect(recipes).toHaveLength(9);
    expect(recipes[7]).toMatchObject({
      output: '07-live-activity.png',
      layout: 'store-live-activity',
      sources: [],
      liveActivity: { boardFamily: 'kilter' },
    });
    const kilter = readCppPage('kilter');
    expect(cppCaptureNames(kilter, 'iphone-16-pro')).not.toContain('08-island.png');
    expect(cppCaptureNames(kilter, 'ipad-pro-13-inch-m5')).toContain('08-kiosk.png');
    expect(kilter.recipes.phone).toHaveLength(9);
    const tension = readCppPage('tension');
    expect(cppCaptureNames(tension, 'iphone-16-pro')).not.toContain('08-island.png');
    expect(tension.recipes.phone[4]).toMatchObject({
      output: '04-live-activity.png',
      layout: 'store-live-activity',
      sources: [],
      liveActivity: { boardFamily: 'tension' },
    });
    expect(cppCaptureNames(readCppPage('moonboard'), 'iphone-16-pro')).toContain('08-island.png');
  });
  it('pins four full Kilter Notification Center captures without inferring lock state or a source commit', () => {
    const approvedSourceHashes = {
      'en-US': 'ee62c3974a1af90d7f6a172a59e523627babc205a3d40d1d43598847e38ebde8',
      es: 'c7b727d98ee23d09476b38985e6d081e1b38581758693183f51f61080680da5c',
      fr: 'e1991c81e5d03457b9fc2e5f14371b73091918e734efb11286a5a64284774acd',
      de: 'cb509013ab5b85d184d4feb0e20929b534ad8848ad74f645a358d1e796c403a4',
    };
    const sourceHashes = new Set<string>();
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const loaded = loadFullScreenLiveActivityFixture('kilter', locale);
      expect(loaded.provenance).toMatchObject({
        appLocale: locale,
        widgetLocale: 'en',
        device: 'iPhone13Pro',
        sourceBuild: 'TestFlight2.6.0(18)',
        appSourceCommit: null,
        captureFraming: 'full-screen',
        captureSurface: 'notification-center',
        nativePixels: { width: 1170, height: 2532 },
        screenPoints: { width: 390, height: 844 },
        cropRect: { x: 0, y: 0, width: 1170, height: 2532 },
        notificationCenterContext: {
          wallpaper: 'iOS stock Astronomy Earth',
          unrelatedNotificationsDismissed: true,
          entryFromAuthenticatedApp: true,
          authenticationState: 'not-established',
        },
        content: {
          climbName: 'Lightest Pair of Shorts',
          grade: locale === 'es' ? '6b/V4' : 'V4',
          currentIndex: 1,
          totalClimbs: 2,
          nextEnabled: true,
        },
      });
      expect(loaded.provenance.sourcePngSha256).toBe(approvedSourceHashes[locale]);
      expect(loaded.provenance.sha256).toBe(approvedSourceHashes[locale]);
      expect(nativeCaptureSha256(loaded.pixels)).toBe(approvedSourceHashes[locale]);
      expect(loaded.provenance.extraction).toBeUndefined();
      expect(loaded.provenance.lockScreenContext).toBeUndefined();
      expect(loaded.provenance.notificationCenterContext).not.toHaveProperty('deviceLocked');
      sourceHashes.add(loaded.provenance.sourcePngSha256);
    }
    expect(sourceHashes.size).toBe(4);
  });
  it('pins four full Tension captures with honest development-controller compatibility', () => {
    const approvedSourceHashes = {
      'en-US': '5b48626574fb5915267b18452b822ae2be2c454e106f1bcd7216918d15ac6a03',
      es: 'cb8b07a6b1258db12893ff655cf74fbea976a8717de6ac9a88cec4c32d6b1f56',
      fr: 'f7b205e4d3ccac58d472ddb8223df34db6ac79ceb92b4bae09d03e26799cf913',
      de: '66e3d5dcf2add3ffb47a80ce1f02858cf6ec1c32847cae4d572bb7cc2948364c',
    };
    const sourceHashes = new Set<string>();
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const loaded = loadFullScreenLiveActivityFixture('tension', locale);
      expect(loaded.provenance).toMatchObject({
        boardFamily: 'tension',
        appLocale: locale,
        widgetLocale: 'en',
        sourceBuild: 'TestFlight2.6.0(18)',
        appSourceCommit: null,
        captureFraming: 'full-screen',
        captureSurface: 'notification-center',
        cropRect: { x: 0, y: 0, width: 1170, height: 2532 },
        notificationCenterContext: {
          unrelatedNotificationsDismissed: true,
          entryFromAuthenticatedApp: true,
          authenticationState: 'not-established',
        },
        content: {
          climbName: 'Masquerade',
          grade: locale === 'es' ? 'V3' : '6a/V3',
          currentIndex: 1,
          totalClimbs: 2,
          nextEnabled: true,
        },
        controller: {
          presentedBoardFamily: 'kilter',
          physicalWallLightingVerified: false,
          compatibility: {
            protocol: 'aurora-uart',
            targetBoardFamily: 'tension',
            serialMismatchAccepted: true,
            verification: 'native-next-and-received-led-payload',
          },
        },
      });
      expect(loaded.provenance.sha256).toBe(approvedSourceHashes[locale]);
      expect(loaded.provenance.sourcePngSha256).toBe(approvedSourceHashes[locale]);
      expect(nativeCaptureSha256(loaded.pixels)).toBe(approvedSourceHashes[locale]);
      expect(loaded.provenance.extraction).toBeUndefined();
      expect(loaded.provenance.lockScreenContext).toBeUndefined();
      expect(loaded.provenance.notificationCenterContext).not.toHaveProperty('deviceLocked');
      sourceHashes.add(loaded.provenance.sourcePngSha256);
    }
    expect(sourceHashes.size).toBe(4);
  });
});
