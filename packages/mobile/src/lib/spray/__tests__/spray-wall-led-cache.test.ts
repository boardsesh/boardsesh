import { describe, expect, it } from 'vitest';
import { readSprayWallLedSettings } from '../spray-wall-led-cache';

const base = { version: 1, enabled: true, controller: { type: 'wled', url: 'http://wled.local' } };

describe('reading a wall’s cached LED settings', () => {
  it('reads a copy saved before brightness and auto-off with their defaults', () => {
    expect(readSprayWallLedSettings(base)).toEqual({ ...base, brightness: 64, autoOffMinutes: 0 });
    expect(readSprayWallLedSettings(null)).toMatchObject({ enabled: false, brightness: 64, autoOffMinutes: 0 });
  });

  it('keeps saved values and clamps them to what the controller accepts', () => {
    expect(readSprayWallLedSettings({ ...base, brightness: 128, autoOffMinutes: 30 })).toMatchObject({
      brightness: 128,
      autoOffMinutes: 30,
    });
    expect(readSprayWallLedSettings({ ...base, brightness: 900, autoOffMinutes: -5 })).toMatchObject({
      brightness: 255,
      autoOffMinutes: 0,
    });
  });

  it('refuses a copy whose lighting values are not numbers', () => {
    expect(() => readSprayWallLedSettings({ ...base, brightness: 'bright' })).toThrow();
    expect(() => readSprayWallLedSettings({ ...base, autoOffMinutes: '15' })).toThrow();
  });
});
