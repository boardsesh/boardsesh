import { describe, expect, it } from 'vitest';
import {
  getBleLightbulbAccessibilityHint,
  getBleLightbulbLabelKind,
  getBleLightbulbDisplayMode,
  getBleLightbulbSpinnerSize,
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

  it('scales the spinner with the icon size instead of pinning it small', () => {
    // Both shipping call sites pass 24 and keep the 20pt spinner.
    expect(getBleLightbulbSpinnerSize(24)).toBe('small');
    expect(getBleLightbulbSpinnerSize(31)).toBe('small');
    // A larger icon swaps to the 36pt spinner so the control doesn't visibly
    // shrink mid-write.
    expect(getBleLightbulbSpinnerSize(32)).toBe('large');
    expect(getBleLightbulbSpinnerSize(48)).toBe('large');
  });
});

describe('getBleLightbulbLabelKind', () => {
  // The label has to describe the TAP, not the fill: the bulb reads lit while a
  // peer drives the wall, and all three surfaces used to promise "Connect to
  // board" there for a tap that connects to nothing (Fable review, PR #5123).
  it('names the disconnect a tap will perform', () => {
    expect(getBleLightbulbLabelKind('disconnect', false)).toBe('disconnect');
    // Ownership doesn't change what a disconnect tap does.
    expect(getBleLightbulbLabelKind('disconnect', true)).toBe('disconnect');
  });

  it('names the relay when the tap puts a climb on a peer wall', () => {
    expect(getBleLightbulbLabelKind('relay', true)).toBe('relay');
  });

  it('says a peer is driving only when one actually is', () => {
    expect(getBleLightbulbLabelKind('noop', true)).toBe('peerDriving');
  });

  it('does not blame a peer for the other reasons a tap does nothing', () => {
    // 'noop' also covers "no board selected yet" and "a connect is already in
    // flight". Neither should tell a screen reader someone else has the board.
    expect(getBleLightbulbLabelKind('noop', false)).toBe('connect');
  });

  it('falls back to connect', () => {
    expect(getBleLightbulbLabelKind('connect', false)).toBe('connect');
  });
});
