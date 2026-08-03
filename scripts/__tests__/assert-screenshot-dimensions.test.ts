import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Dimensions,
  EXPECTED_APP_STORE_LOCALES,
  findGooglePlayOffenders,
  findOffenders,
  findScreenshotTreeOffenders,
  readPngDimensions,
  type ScreenshotTree,
} from '../assert-screenshot-dimensions';

/** Build a minimal valid PNG header: signature + IHDR length + "IHDR" + width/height. */
function pngHeader({ width, height }: Dimensions): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); // IHDR data length
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('readPngDimensions', () => {
  it('reads width/height from a valid PNG IHDR', () => {
    expect(readPngDimensions(pngHeader({ width: 1320, height: 2868 }))).toEqual({
      width: 1320,
      height: 2868,
    });
  });

  it('throws on a non-PNG buffer', () => {
    expect(() => readPngDimensions(Buffer.from('this is not a png at all'))).toThrow(/PNG/);
  });

  it('throws on a truncated buffer', () => {
    expect(() => readPngDimensions(Buffer.alloc(10))).toThrow();
  });
});

describe('findOffenders', () => {
  const slug = 'iphone-16-pro-max';

  it('accepts the iPhone 16 Pro Max native size', () => {
    const offenders = findOffenders(slug, [
      { name: `${slug}/00-home.png`, buffer: pngHeader({ width: 1320, height: 2868 }) },
    ]);
    expect(offenders).toEqual([]);
  });

  it('accepts the alternate 6.9" size (1290x2796)', () => {
    const offenders = findOffenders(slug, [
      { name: `${slug}/00-home.png`, buffer: pngHeader({ width: 1290, height: 2796 }) },
    ]);
    expect(offenders).toEqual([]);
  });

  it('fails closed for the dropped Plus/Pro slugs (only 6.9" is captured now)', () => {
    expect(
      findOffenders('iphone-14-plus', [
        { name: 'iphone-14-plus/00-home.png', buffer: pngHeader({ width: 1284, height: 2778 }) },
      ])[0].reason,
    ).toMatch(/no accepted-size list/);
    expect(
      findOffenders('iphone-16-pro', [
        { name: 'iphone-16-pro/00-home.png', buffer: pngHeader({ width: 1206, height: 2622 }) },
      ])[0].reason,
    ).toMatch(/no accepted-size list/);
  });

  it('accepts the iPad landscape App Store sizes', () => {
    expect(
      findOffenders('ipad-pro-13-inch-m5', [
        { name: 'ipad-pro-13-inch-m5/00-home.png', buffer: pngHeader({ width: 2752, height: 2064 }) },
      ]),
    ).toEqual([]);
    expect(
      findOffenders('ipad-pro-13-inch-m5', [
        { name: 'ipad-pro-13-inch-m5/00-home.png', buffer: pngHeader({ width: 2732, height: 2048 }) },
      ]),
    ).toEqual([]);
    expect(
      findOffenders('ipad-pro-11-inch-m5', [
        { name: 'ipad-pro-11-inch-m5/00-home.png', buffer: pngHeader({ width: 2420, height: 1668 }) },
      ]),
    ).toEqual([]);
  });

  it('rejects portrait iPad screenshots for the landscape store slots', () => {
    const offenders = findOffenders('ipad-pro-13-inch-m5', [
      { name: 'ipad-pro-13-inch-m5/00-home.png', buffer: pngHeader({ width: 2064, height: 2752 }) },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].reason).toMatch(/2064x2752/);
  });

  it('flags a wrong size, reporting both file and dimensions', () => {
    const offenders = findOffenders(slug, [
      { name: `${slug}/bad.png`, buffer: pngHeader({ width: 1284, height: 2778 }) },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].file).toBe(`${slug}/bad.png`);
    expect(offenders[0].reason).toMatch(/1284x2778/);
  });

  it('fails closed for an unknown device slug', () => {
    const offenders = findOffenders('pixel-9-pro', [
      { name: 'pixel-9-pro/00-home.png', buffer: pngHeader({ width: 1320, height: 2868 }) },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].reason).toMatch(/no accepted-size list/);
  });

  it('reports a corrupt PNG as an offender rather than throwing', () => {
    const offenders = findOffenders(slug, [{ name: `${slug}/corrupt.png`, buffer: Buffer.alloc(4) }]);
    expect(offenders).toHaveLength(1);
  });
});

describe('findScreenshotTreeOffenders', () => {
  function screenshotTree(overrides: Partial<ScreenshotTree> = {}): ScreenshotTree {
    const baseTree: ScreenshotTree = {};
    // Derived, not literal: a new store locale must widen the fixture too, or
    // every case below would fail on a spurious "missing locale" offender.
    for (const locale of EXPECTED_APP_STORE_LOCALES) {
      baseTree[locale] = {
        'iphone-16-pro-max': [
          {
            name: `${locale}/iphone-16-pro-max/00-home.png`,
            buffer: pngHeader({ width: 1320, height: 2868 }),
          },
        ],
        'ipad-pro-13-inch-m5': [
          {
            name: `${locale}/ipad-pro-13-inch-m5/00-home.png`,
            buffer: pngHeader({ width: 2752, height: 2064 }),
          },
        ],
        'ipad-pro-11-inch-m5': [
          {
            name: `${locale}/ipad-pro-11-inch-m5/00-home.png`,
            buffer: pngHeader({ width: 2420, height: 1668 }),
          },
        ],
      };
    }
    for (const [locale, devices] of Object.entries(overrides)) {
      if (devices) {
        baseTree[locale] = devices;
      }
    }
    return baseTree;
  }

  it('accepts a complete localized common-device tree', () => {
    expect(findScreenshotTreeOffenders(screenshotTree())).toEqual([]);
  });

  it('flags a missing expected iPad device folder even when every locale is consistent', () => {
    const tree = screenshotTree();
    for (const devices of Object.values(tree)) {
      delete devices['ipad-pro-11-inch-m5'];
    }
    const offenders = findScreenshotTreeOffenders(tree);
    expect(
      offenders.some(
        (offender) =>
          offender.file === 'en-US/ipad-pro-11-inch-m5' && /missing device screenshot folder/.test(offender.reason),
      ),
    ).toBe(true);
  });

  it('flags missing App Store locales', () => {
    const tree = screenshotTree();
    delete tree['fr-FR'];
    const offenders = findScreenshotTreeOffenders(tree);
    expect(offenders.some((offender) => offender.file === 'fr-FR' && /missing/.test(offender.reason))).toBe(true);
  });

  it('flags an unknown App Store locale directory', () => {
    const tree = screenshotTree({
      'ja-JP': {
        'iphone-16-pro-max': [
          {
            name: 'ja-JP/iphone-16-pro-max/00-home.png',
            buffer: pngHeader({ width: 1320, height: 2868 }),
          },
        ],
        'ipad-pro-13-inch-m5': [
          {
            name: 'ja-JP/ipad-pro-13-inch-m5/00-home.png',
            buffer: pngHeader({ width: 2752, height: 2064 }),
          },
        ],
        'ipad-pro-11-inch-m5': [
          {
            name: 'ja-JP/ipad-pro-11-inch-m5/00-home.png',
            buffer: pngHeader({ width: 2420, height: 1668 }),
          },
        ],
      },
    });
    const offenders = findScreenshotTreeOffenders(tree);
    expect(
      offenders.some((offender) => offender.file === 'ja-JP' && /unknown App Store locale/.test(offender.reason)),
    ).toBe(true);
  });

  it('flags inconsistent device sets across locales', () => {
    const tree = screenshotTree({
      'es-ES': {
        // A different device slug than the reference's iphone-16-pro-max.
        'iphone-14-plus': [
          {
            name: 'es-ES/iphone-14-plus/00-home.png',
            buffer: pngHeader({ width: 1284, height: 2778 }),
          },
        ],
      },
    });
    const offenders = findScreenshotTreeOffenders(tree);
    expect(offenders.some((offender) => offender.file === 'es-ES' && /device folders/.test(offender.reason))).toBe(
      true,
    );
  });

  it('flags inconsistent PNG sets across locales', () => {
    const tree = screenshotTree({
      'es-MX': {
        // Same device as the reference but a different PNG set (01-climbs vs 00-home).
        'iphone-16-pro-max': [
          {
            name: 'es-MX/iphone-16-pro-max/01-climbs.png',
            buffer: pngHeader({ width: 1320, height: 2868 }),
          },
        ],
      },
    });
    const offenders = findScreenshotTreeOffenders(tree);
    expect(
      offenders.some((offender) => offender.file === 'es-MX/iphone-16-pro-max' && /PNG set/.test(offender.reason)),
    ).toBe(true);
  });
});

describe('findGooglePlayOffenders', () => {
  const slug = 'pixel-2';

  it('accepts 2-8 Play phone screenshots in the allowed size range', () => {
    const offenders = findGooglePlayOffenders(slug, [
      { name: `${slug}/00-home.png`, buffer: pngHeader({ width: 1080, height: 1920 }) },
      { name: `${slug}/01-climbs.png`, buffer: pngHeader({ width: 1080, height: 1920 }) },
    ]);
    expect(offenders).toEqual([]);
  });

  it('requires at least two Play phone screenshots', () => {
    const offenders = findGooglePlayOffenders(slug, [
      { name: `${slug}/00-home.png`, buffer: pngHeader({ width: 1080, height: 1920 }) },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].reason).toMatch(/at least 2/);
  });

  it('rejects more than eight Play phone screenshots', () => {
    const files = Array.from({ length: 9 }, (_, index) => ({
      name: `${slug}/0${index}-shot.png`,
      buffer: pngHeader({ width: 1080, height: 1920 }),
    }));
    const offenders = findGooglePlayOffenders(slug, files);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].reason).toMatch(/at most 8/);
  });

  it('rejects Play screenshots below the minimum side length', () => {
    const offenders = findGooglePlayOffenders(slug, [
      { name: `${slug}/00-home.png`, buffer: pngHeader({ width: 319, height: 568 }) },
      { name: `${slug}/01-climbs.png`, buffer: pngHeader({ width: 1080, height: 1920 }) },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].reason).toMatch(/at least 320px/);
  });

  it('rejects Play screenshots whose long side is more than twice the short side', () => {
    const offenders = findGooglePlayOffenders(slug, [
      { name: `${slug}/00-home.png`, buffer: pngHeader({ width: 1000, height: 2100 }) },
      { name: `${slug}/01-climbs.png`, buffer: pngHeader({ width: 1080, height: 1920 }) },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].reason).toMatch(/no more than 2x/);
  });
});

describe('Fastfile locale allowlist', () => {
  // EXPECTED_DELIVER_LOCALES is the gate `fastlane ios screenshots` runs before
  // uploading, and it's Ruby — nothing else in the TS test suite can see it, so
  // it would drift silently on the next locale and only surface as a failed
  // upload at release time. Parse the constant and hold it to the TS list.
  it('matches EXPECTED_APP_STORE_LOCALES', () => {
    const fastfile = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../fastlane/Fastfile'), 'utf8');
    const declaration = fastfile.match(/^EXPECTED_DELIVER_LOCALES\s*=\s*\[([^\]]*)\]/m);
    expect(declaration, 'EXPECTED_DELIVER_LOCALES not found in fastlane/Fastfile').not.toBeNull();
    const locales = [...(declaration?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
    expect(locales.sort()).toEqual([...EXPECTED_APP_STORE_LOCALES].sort());
  });
});
