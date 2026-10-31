// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWallGlowLayer, type WallGlowInput } from '../use-wall-glow';
import { wallGlowLabelFade } from '../wall-glow';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: 27, select: (options: { ios?: unknown }) => options.ios },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
}));

const glow: WallGlowInput = {
  key: 'edge-lit-climb',
  holds: [{ x: 75, y: 8, color: '#4DF5FD' }],
  boardWidth: 100,
  boardHeight: 120,
};

describe('useWallGlowLayer readable zone', () => {
  it('retains the player’s centered policy by default', () => {
    const { result } = renderHook(() => useWallGlowLayer(glow, 210, 38, 'dark'));
    const layer = result.current;
    expect(layer?.readableZone).toBe('center');
    if (!layer) throw new Error('Expected a wall glow layer');
    expect(layer.fade).toBe(
      wallGlowLabelFade(
        layer.blobs,
        { w: 210, h: 38 },
        {
          surface: layer.surface,
          blend: layer.blend,
          opacityScale: layer.opacityScale,
        },
      ),
    );
  });

  it('recomputes the fade when the same geometry needs the whole header protected', () => {
    const { result, rerender } = renderHook(
      ({ readableZone }: { readableZone: 'center' | 'full' }) => useWallGlowLayer(glow, 80, 38, 'dark', readableZone),
      { initialProps: { readableZone: 'center' as 'center' | 'full' } },
    );
    const centered = result.current;
    rerender({ readableZone: 'full' });
    const full = result.current;
    expect(full).not.toBe(centered);
    expect(full?.readableZone).toBe('full');
    if (!full) throw new Error('Expected a full-width header glow');
    expect(full.fade).toBe(
      wallGlowLabelFade(
        full.blobs,
        { w: 80, h: 38 },
        {
          surface: full.surface,
          blend: full.blend,
          opacityScale: full.opacityScale,
          readableZone: 'full',
        },
      ),
    );
    expect(full.fade).toBeGreaterThanOrEqual(centered?.fade ?? 0);
  });
});
