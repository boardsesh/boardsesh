import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodePng, encodePng, base64ToBytes, bytesToBase64 } from '../png-codec';
import { maskToCircle } from '../circle-mask';

const manipulator = vi.hoisted(() => ({
  manipulate: vi.fn(),
  saveBase64: null as string | null,
  sourceSize: { width: 120, height: 90 },
  crops: [] as Array<{ originX: number; originY: number; width: number; height: number }>,
  released: 0,
}));

vi.mock('expo-image-manipulator', () => {
  const ref = (width: number, height: number) => ({
    width,
    height,
    saveAsync: async () => ({ uri: 'file:///cache/x.png', width, height, base64: manipulator.saveBase64 ?? undefined }),
    release: () => {
      manipulator.released++;
    },
  });
  const context = (size: { width: number; height: number }) => {
    let output = size;
    const chain = {
      crop: (rect: { originX: number; originY: number; width: number; height: number }) => {
        manipulator.crops.push(rect);
        output = { width: rect.width, height: rect.height };
        return chain;
      },
      resize: (target: { width: number; height: number }) => {
        output = target;
        return chain;
      },
      renderAsync: async () => ref(output.width, output.height),
    };
    return chain;
  };
  return {
    SaveFormat: { PNG: 'png' },
    ImageManipulator: {
      manipulate: (source: unknown) => {
        manipulator.manipulate(source);
        return context(
          typeof source === 'string' ? manipulator.sourceSize : (source as { width: number; height: number }),
        );
      },
    },
  };
});

import { clearRoundAvatarCache, loadRoundAvatar } from '../round-avatar';

function opaqueSquarePngBase64(side: number): string {
  return bytesToBase64(
    encodePng({
      width: side,
      height: side,
      pixels: new Uint8Array(side * side * 4).map((_value, index) => (index % 4 === 3 ? 255 : 200)),
    }),
  );
}

beforeEach(() => {
  clearRoundAvatarCache();
  manipulator.manipulate.mockReset();
  manipulator.saveBase64 = opaqueSquarePngBase64(12);
  manipulator.crops = [];
  manipulator.released = 0;
});

describe('maskToCircle', () => {
  it('clears the corners, keeps the centre and blends the rim', () => {
    const side = 12;
    const round = maskToCircle({ width: side, height: side, pixels: new Uint8Array(side * side * 4).fill(255) });
    const alpha = (column: number, row: number) => round.pixels[(row * side + column) * 4 + 3];
    expect(alpha(0, 0)).toBe(0);
    expect(alpha(11, 11)).toBe(0);
    expect(alpha(6, 6)).toBe(255);
    expect(alpha(0, 6)).toBeGreaterThan(0);
    expect(alpha(0, 6)).toBeLessThan(255);
  });
});

describe('loadRoundAvatar', () => {
  it('squares the photo from its centre and returns it as a round PNG data URI', async () => {
    const image = await loadRoundAvatar('https://x/static/avatars/me.jpg?size=28', 12);
    expect(manipulator.crops).toEqual([{ originX: 15, originY: 0, width: 90, height: 90 }]);
    expect(image?.pixelSize).toBe(12);
    expect(image?.uri.startsWith('data:image/png;base64,')).toBe(true);
    const decoded = decodePng(base64ToBytes(image?.uri.slice('data:image/png;base64,'.length) ?? ''));
    expect(decoded?.pixels[3]).toBe(0); // top-left corner is cut away
    expect(decoded?.pixels[(6 * 12 + 6) * 4 + 3]).toBe(255);
    expect(manipulator.released).toBe(2);
  });

  it('makes each photo once per size', async () => {
    const first = loadRoundAvatar('https://x/a.jpg', 12);
    const second = loadRoundAvatar('https://x/a.jpg', 12);
    expect(second).toBe(first);
    await first;
    await loadRoundAvatar('https://x/a.jpg', 12);
    expect(manipulator.manipulate).toHaveBeenCalledTimes(2); // load + square, one photo
  });

  it('returns null for a photo it cannot read, and tries again next time', async () => {
    manipulator.saveBase64 = null;
    expect(await loadRoundAvatar('https://x/a.jpg', 12)).toBeNull();
    manipulator.saveBase64 = opaqueSquarePngBase64(12);
    expect(await loadRoundAvatar('https://x/a.jpg', 12)).not.toBeNull();
  });

  it('returns null when the photo fails to load', async () => {
    manipulator.manipulate.mockImplementationOnce(() => {
      throw new Error('404');
    });
    expect(await loadRoundAvatar('https://x/gone.jpg', 12)).toBeNull();
  });
});
