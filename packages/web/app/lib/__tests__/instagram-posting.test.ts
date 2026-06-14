import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  buildInstagramCaption,
  copyAndOpenInstagram,
  copyInstagramCaption,
  getBoardDisplayName,
  getInstagramPostingPlatform,
  isInstagramPostingSupported,
  openInstagramCamera,
} from '../instagram-posting';

const originalNavigator = global.navigator;
const originalWindow = global.window;
const originalDocument = global.document;

describe('instagram-posting', () => {
  beforeEach(() => {
    Object.defineProperty(global, 'window', {
      configurable: true,
      value: {
        Capacitor: undefined,
        location: { href: '' },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        clearTimeout: vi.fn(),
        setTimeout: vi.fn((callback: () => void) => {
          queueMicrotask(callback);
          return 1;
        }),
      },
    });

    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      },
    });

    Object.defineProperty(global, 'document', {
      configurable: true,
      value: {
        visibilityState: 'hidden',
        hidden: true,
        body: {
          appendChild: vi.fn(),
          removeChild: vi.fn(),
        },
        createElement: vi.fn((tag: string) => ({
          tagName: tag.toUpperCase(),
          style: {},
          value: '',
          textContent: '',
          contentEditable: '',
          focus: vi.fn(),
          select: vi.fn(),
          setSelectionRange: vi.fn(),
          setAttribute: vi.fn(),
        })),
        execCommand: vi.fn(() => true),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        createRange: vi.fn(() => ({
          selectNodeContents: vi.fn(),
        })),
      },
    });

    Object.defineProperty(global.window, 'getSelection', {
      configurable: true,
      value: vi.fn(() => ({
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    Object.defineProperty(global, 'window', {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(global, 'document', {
      configurable: true,
      value: originalDocument,
    });
  });

  it('builds the Kilter caption when boardType is omitted', () => {
    expect(buildInstagramCaption({ climbName: 'Texas Sun', angle: 35 })).toBe(
      `"Texas Sun" @ 35° on the Kilter Board.\n@kilterboard #kilterboard #kiltergrips @boardsesh #boardsesh`,
    );
  });

  it('builds the Kilter caption when boardType is kilter', () => {
    expect(buildInstagramCaption({ climbName: 'Texas Sun', angle: 35, boardType: 'kilter' })).toBe(
      `"Texas Sun" @ 35° on the Kilter Board.\n@kilterboard #kilterboard #kiltergrips @boardsesh #boardsesh`,
    );
  });

  it('builds the caption for Tension', () => {
    expect(buildInstagramCaption({ climbName: 'High Hopes', angle: 40, boardType: 'tension' })).toBe(
      `"High Hopes" @ 40° on the Tension Board. @tensionclimbing #tensionboard #climbing #bouldering @boardsesh #boardsesh`,
    );
  });

  it.each([
    ['decoy', 'Decoy Board'],
    ['touchstone', 'Touchstone Board'],
    ['grasshopper', 'Grasshopper Board'],
    ['soill', 'So iLL Board'],
  ])('builds a Tension-style caption for the %s board', (boardType, boardName) => {
    expect(buildInstagramCaption({ climbName: 'Sandbag', angle: 30, boardType })).toBe(
      `"Sandbag" @ 30° on the ${boardName}. #climbing #bouldering @boardsesh #boardsesh`,
    );
  });

  it('builds the full MoonBoard caption with grade, layout, and setter', () => {
    expect(
      buildInstagramCaption({
        climbName: 'Wheel of Fortune',
        angle: 40,
        boardType: 'moonboard',
        grade: 'V7',
        setter: 'Dana Rader',
        layoutId: 3,
      }),
    ).toBe(
      `Wheel of Fortune, V7, 40° MoonBoard, MoonBoard 2024 setup, set by Dana Rader. - @moonclimbing #moonboard #moonclimbing #moonboardchallenge #trainhardclimbharder @boardsesh #boardsesh`,
    );
  });

  it('builds a degraded MoonBoard caption when grade, setter, and layoutId are missing', () => {
    expect(buildInstagramCaption({ climbName: 'Mystery Route', angle: 40, boardType: 'moonboard' })).toBe(
      `Mystery Route, 40° MoonBoard. - @moonclimbing #moonboard #moonclimbing #moonboardchallenge #trainhardclimbharder @boardsesh #boardsesh`,
    );
  });

  it('falls back to Kilter caption for an unknown boardType', () => {
    expect(buildInstagramCaption({ climbName: 'Mystery Route', angle: 50, boardType: 'unknownboard' })).toBe(
      `"Mystery Route" @ 50° on the Kilter Board.\n@kilterboard #kilterboard #kiltergrips @boardsesh #boardsesh`,
    );
  });

  describe('getBoardDisplayName', () => {
    it('returns the short display name for known boards', () => {
      expect(getBoardDisplayName('kilter')).toBe('Kilter');
      expect(getBoardDisplayName('tension')).toBe('Tension');
      expect(getBoardDisplayName('moonboard')).toBe('MoonBoard');
    });

    it('capitalises and returns the raw boardType for unknown boards', () => {
      expect(getBoardDisplayName('futureboard')).toBe('Futureboard');
    });
  });

  it('detects iPhone web as supported', () => {
    expect(getInstagramPostingPlatform()).toBe('ios');
    expect(isInstagramPostingSupported()).toBe(true);
  });

  it('detects Android mobile web as supported', () => {
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: {
        userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/136.0 Mobile Safari/537.36',
      },
    });

    expect(getInstagramPostingPlatform()).toBe('android');
    expect(isInstagramPostingSupported()).toBe(true);
  });

  it('treats desktop web as unsupported', () => {
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0 Safari/537.36',
      },
    });

    expect(getInstagramPostingPlatform()).toBe('unsupported');
    expect(isInstagramPostingSupported()).toBe(false);
  });

  it('falls back to legacy copy and still opens instagram on iPhone web', async () => {
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      },
    });

    const result = await copyAndOpenInstagram('"There, There" @ 40° on the Kilter Board.');

    expect(global.document.execCommand).toHaveBeenCalledWith('copy'); // eslint-disable-line @typescript-eslint/unbound-method -- vi.fn() mock, no `this` concern
    expect(result).toEqual({ copied: true, opened: true });
    expect(global.window.location.href).toBe('instagram://camera');
  });

  it('copies the Instagram caption without opening Instagram', async () => {
    const copied = await copyInstagramCaption('"There, There" @ 40° on the Kilter Board.');

    expect(global.document.execCommand).toHaveBeenCalledWith('copy'); // eslint-disable-line @typescript-eslint/unbound-method -- vi.fn() mock, no `this` concern
    expect(copied).toBe(true);
    expect(global.window.location.href).toBe('');
  });

  it('opens Instagram camera without copying a caption', async () => {
    const opened = await openInstagramCamera();

    expect(opened).toBe(true);
    expect(global.document.execCommand).not.toHaveBeenCalled();
    expect(global.window.location.href).toBe('instagram://camera');
  });

  it('reports copied: false and does not launch Instagram when both copy paths fail', async () => {
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        clipboard: {
          writeText: vi.fn(() => Promise.reject(new Error('clipboard blocked'))),
        },
      },
    });
    global.document.execCommand = vi.fn(() => false);
    global.window.location.href = '';

    const result = await copyAndOpenInstagram('whatever caption');

    expect(result).toEqual({ copied: false, opened: false });
    expect(global.window.location.href).toBe('');
  });
});
