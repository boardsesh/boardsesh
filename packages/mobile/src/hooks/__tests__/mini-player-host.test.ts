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

  it.each(['material', 'liquidGlass'] as const)('adds a card beside the desktop pane on %s', (variant) => {
    expect(resolveMiniPlayerHost({ home: 'detailPane', variant, platformOS: 'web', sidebarShell: true })).toBe(
      'materialCard',
    );
    expect(resolveMiniPlayerHost({ home: 'floatingBar', variant, platformOS: 'web', sidebarShell: true })).toBe(
      'materialCard',
    );
  });

  it.each(['android', 'ios'])('keeps the native %s tablet pane without a bar', (platformOS) => {
    expect(
      resolveMiniPlayerHost({ home: 'detailPane', variant: 'material', platformOS, sidebarShell: true }),
    ).toBeNull();
  });

  it('keeps compact browser chrome and native accessories unchanged', () => {
    expect(
      resolveMiniPlayerHost({ home: 'floatingBar', variant: 'liquidGlass', platformOS: 'web', sidebarShell: false }),
    ).toBeNull();
    expect(
      resolveMiniPlayerHost({
        home: 'nativeAccessory',
        variant: 'liquidGlass',
        platformOS: 'ios',
        sidebarShell: false,
      }),
    ).toBe('nativeAccessory');
  });

  it('is nothing where the glass capsule or the tablet pane holds the climb', () => {
    expect(resolveMiniPlayerHost({ home: 'floatingBar', variant: 'liquidGlass' })).toBeNull();
    expect(resolveMiniPlayerHost({ home: 'detailPane', variant: 'material' })).toBeNull();
    expect(resolveMiniPlayerHost({ home: 'detailPane', variant: 'liquidGlass' })).toBeNull();
  });
});
