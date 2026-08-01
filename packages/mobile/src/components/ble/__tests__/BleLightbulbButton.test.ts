import { describe, expect, it } from 'vitest';
import {
  getBleLightbulbAccessibilityHint,
  getBleLightbulbDisplayMode,
  getBleLightbulbVisualState,
} from '../ble-lightbulb-button-state';

describe('BleLightbulbButton state helpers', () => {
  it('uses the outline lightbulb and neutral color when disconnected', () => {
    expect(
      getBleLightbulbVisualState({
        isConnected: false,
        connectedColor: '#ffcc00',
        disconnectedColor: '#8e8e93',
      }),
    ).toEqual({
      iconName: 'lightbulb',
      iconColor: '#8e8e93',
    });
  });

  it('uses the filled lightbulb and glow colors when connected', () => {
    expect(
      getBleLightbulbVisualState({
        isConnected: true,
        connectedColor: '#ffcc00',
        disconnectedColor: '#8e8e93',
      }),
    ).toEqual({
      iconName: 'lightbulb.fill',
      iconColor: '#ffcc00',
      backgroundColor: '#ffcc0024',
      shadowColor: '#ffcc00',
    });
  });

  it('resolves scanning before writing before the long-press hint', () => {
    expect(
      getBleLightbulbAccessibilityHint(
        true,
        true,
        'Scanning for boards nearby',
        'Lighting the board',
        'Hold for controls',
      ),
    ).toBe('Scanning for boards nearby');
    expect(
      getBleLightbulbAccessibilityHint(
        false,
        true,
        'Scanning for boards nearby',
        'Lighting the board',
        'Hold for controls',
      ),
    ).toBe('Lighting the board');
    expect(
      getBleLightbulbAccessibilityHint(
        false,
        false,
        'Scanning for boards nearby',
        'Lighting the board',
        'Hold for controls',
      ),
    ).toBe('Hold for controls');
  });

  it('does not fall back to the long-press hint while scanning without a scanning hint', () => {
    // Scanning takes precedence: a missing scanning hint must not read as the
    // long-press action (the bug the third arg guards against).
    expect(
      getBleLightbulbAccessibilityHint(true, true, undefined, 'Lighting the board', 'Hold for controls'),
    ).toBeUndefined();
  });

  it('uses scanning before writing before idle for the display mode', () => {
    expect(getBleLightbulbDisplayMode(true, true)).toBe('scanning');
    expect(getBleLightbulbDisplayMode(false, true)).toBe('writing');
    expect(getBleLightbulbDisplayMode(false, false)).toBe('idle');
  });
});
