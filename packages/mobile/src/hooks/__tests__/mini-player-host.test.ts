import { describe, expect, it } from 'vitest';
import { resolveMiniPlayerHost } from '../mini-player-host';

describe('resolveMiniPlayerHost', () => {
  it('is the native accessory wherever the accessory holds the climb, in either variant', () => {
    expect(resolveMiniPlayerHost({ home: 'nativeAccessory', variant: 'liquidGlass' })).toBe('nativeAccessory');
    expect(resolveMiniPlayerHost({ home: 'nativeAccessory', variant: 'material' })).toBe('nativeAccessory');
  });

  it('is the Material card where the JS floating bar holds the climb on Material', () => {
    expect(resolveMiniPlayerHost({ home: 'floatingBar', variant: 'material' })).toBe('materialCard');
  });

  it('is nothing where the glass capsule or the tablet pane holds the climb', () => {
    expect(resolveMiniPlayerHost({ home: 'floatingBar', variant: 'liquidGlass' })).toBeNull();
    expect(resolveMiniPlayerHost({ home: 'detailPane', variant: 'material' })).toBeNull();
    expect(resolveMiniPlayerHost({ home: 'detailPane', variant: 'liquidGlass' })).toBeNull();
  });
});
