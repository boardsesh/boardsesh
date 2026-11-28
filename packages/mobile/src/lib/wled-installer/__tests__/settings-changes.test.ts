import { describe, expect, it } from 'vitest';
import {
  droppedFeaturesInUse,
  ledOutputChange,
  readManifest,
  settingsDifferences,
  WLED_APP_SLOT_BYTES,
  type JsonObject,
  type SettingsChange,
  type SourceProfile,
} from '../engine';
// Measured on a GL-C-015WL-D: Gledopto's factory settings, then the same file after an over-the-air
// update to WLED 16.0.1 with the BLE JSON add-on (2026-11-26).
import factoryConfig from './fixtures/gledopto-0.15.4-cfg.json';
import updatedConfig from './fixtures/gledopto-0.15.4-to-16.0.1-ble-cfg.json';

const presets = { '0': {} };
const backup = { uri: 'file:///backup.json', config: factoryConfig as JsonObject, presets };
const measured: SettingsChange[] = [
  { path: 'vid', kind: 'changed' },
  { path: 'id.inv', kind: 'removed' },
  { path: 'nw.linked_remote', kind: 'removed' },
  { path: 'hw.led.ledma', kind: 'removed' },
  { path: 'hw.led.ld', kind: 'removed' },
  { path: 'hw.led.prl', kind: 'removed' },
  { path: 'light.tr.mode', kind: 'removed' },
  { path: 'light.tr.fx', kind: 'removed' },
  { path: 'light.tr.pal', kind: 'removed' },
  { path: 'if.mqtt', kind: 'removed', feature: 'mqtt' },
  { path: 'if.hue', kind: 'removed', feature: 'hue' },
  { path: 'if.va', kind: 'removed', feature: 'alexa' },
  // The IR section stays ({"sel":true}); only its pin and type go.
  { path: 'hw.ir.pin', kind: 'removed', feature: 'ir' },
  { path: 'hw.ir.type', kind: 'removed', feature: 'ir' },
  { path: 'nw.espnow', kind: 'removed', feature: 'espnow' },
  { path: 'if.sync.espnow', kind: 'removed', feature: 'espnow' },
];
const factoryProfile: SourceProfile = {
  version: '0.15.4',
  brand: 'GLEDOPTO',
  product: 'GLEDOPTO',
  appSlotBytes: WLED_APP_SLOT_BYTES,
  settingsChanges: measured,
};
function manifestWith(settingsChanges: unknown) {
  return {
    manifestVersion: 1,
    releases: [
      {
        id: 'beta-audio',
        hardwareModel: 'GL-C-015WL-D',
        architecture: 'esp32',
        flashBytes: 4_194_304,
        sourceProfiles: [{ ...factoryProfile, settingsChanges }],
        wledVersion: '16.0.1',
        usermodVersion: '0.1.0',
        protocolVersion: 1,
        buildId: 'beta-audio',
        audio: true,
        imageBytes: 1_000_000,
        appSlotBytes: WLED_APP_SLOT_BYTES,
        url: 'https://example.com/firmware.bin',
        sha256: 'a'.repeat(64),
        qualified: false,
        channel: 'beta',
      },
    ],
  };
}
const after = updatedConfig as JsonObject;

describe('settings kept across the factory Gledopto update', () => {
  it('accepts the real update once its measured changes are listed', () => {
    expect(settingsDifferences(backup, after, presets, {}, measured)).toEqual([]);
  });
  it('reports every unlisted difference of the real update by path', () => {
    const differences = settingsDifferences(backup, after, presets);
    expect(differences).toEqual(
      expect.arrayContaining(['vid', 'id.inv', 'if.mqtt', 'hw.ir.pin', 'light.tr.mode', 'nw.espnow']),
    );
    // Unused button slots and a button count that only grows are not differences.
    expect(differences.filter((path) => path.startsWith('hw.btn'))).toEqual([]);
  });
  it('still catches a real button that was dropped', () => {
    const lost = { ...after, hw: { ...(after.hw as JsonObject), btn: { max: 32, pull: true, ins: [] } } };
    expect(settingsDifferences(backup, lost, presets, {}, measured)).toContain('hw.btn.ins');
  });
  it('fails a "removed" key that is still there with another value', () => {
    const kept = { ...after, id: { ...(after.id as JsonObject), inv: 'Other' } };
    expect(settingsDifferences(backup, kept, presets, {}, measured)).toContain('id.inv');
  });
  it('never lets a listed change excuse a protected setting', () => {
    const moved = structuredClone(after) as { hw: { led: { ins: { pin: number[] }[] } } };
    moved.hw.led.ins[0].pin = [2];
    expect(
      settingsDifferences(backup, moved as unknown as JsonObject, presets, {}, [
        ...measured,
        { path: 'hw.led.ins', kind: 'changed' },
      ]),
    ).toContain('hw.led.ins[0].pin[0]');
  });
  it('rejects a manifest that waives a protected setting, accepts the measured list', () => {
    expect(() => readManifest(manifestWith(measured))).not.toThrow();
    for (const path of ['hw.led.ins', 'hw.led', 'hw', 'nw.ins', 'wifi.sleep', 'um.AudioReactive.config', 'def']) {
      expect(() => readManifest(manifestWith([{ path, kind: 'changed' }]))).toThrow();
    }
    expect(() => readManifest(manifestWith([{ path: 'vid', kind: 'gone' }]))).toThrow();
    expect(() => readManifest(manifestWith([{ path: 'hw..led', kind: 'removed' }]))).toThrow();
  });
});

describe('integrations the build leaves out', () => {
  it('names none when the owner used none of them', () => {
    expect(droppedFeaturesInUse(factoryConfig as JsonObject, factoryProfile)).toEqual([]);
  });
  it('names the ones the owner had on, and any feature the app cannot check', () => {
    const used = {
      ...(factoryConfig as JsonObject),
      if: { ...((factoryConfig as JsonObject).if as JsonObject), mqtt: { en: true } },
      hw: { ...((factoryConfig as JsonObject).hw as JsonObject), ir: { pin: 4, type: 1 } },
    };
    const profile = {
      ...factoryProfile,
      settingsChanges: [...measured, { path: 'if.dmx', kind: 'removed' as const, feature: 'dmx' }],
    };
    expect(droppedFeaturesInUse(used, profile)).toEqual(['mqtt', 'ir', 'dmx']);
  });
});

describe('sizing the controller to the wall', () => {
  const factory = factoryConfig as JsonObject;
  it("turns Gledopto's two 30-LED outputs into one output of what the wiring needs", () => {
    const change = ledOutputChange(factory, 214);
    expect(change).toMatchObject({ current: 60, outputs: 2, pin: 16 });
    const led = (change!.changes.hw as JsonObject).led as JsonObject;
    expect(led.total).toBe(214);
    // Every other setting of the first output is kept, so WLED's defaults never replace them.
    expect(led.ins).toEqual([{ ...((factory.hw as JsonObject).led as { ins: JsonObject[] }).ins[0], len: 214 }]);
  });
  it('leaves a controller alone that already drives enough LEDs, or one it should not rewrite', () => {
    expect(ledOutputChange(factory, 60)).toBeNull();
    expect(ledOutputChange(factory, 40)).toBeNull();
    expect(ledOutputChange(factory, 5000)).toBeNull();
    expect(ledOutputChange(factory, 0)).toBeNull();
    const analog = structuredClone(factory) as { hw: { led: { ins: { type: number }[] } } };
    analog.hw.led.ins[0].type = 41;
    expect(ledOutputChange(analog as unknown as JsonObject, 214)).toBeNull();
    expect(ledOutputChange({}, 214)).toBeNull();
  });
  it('accepts the resized outputs in the settings check, and only the resize', () => {
    const change = ledOutputChange(factory, 214)!;
    // What WLED 16 saves after rebuilding the outputs from the installer's write.
    const resized = structuredClone(after) as { hw: { led: { total: number; ins: JsonObject[] } } };
    resized.hw.led.total = 214;
    resized.hw.led.ins = [{ ...resized.hw.led.ins[0], len: 214 }];
    const config = resized as unknown as JsonObject;
    expect(settingsDifferences(backup, config, presets, change.changes, measured)).toEqual([]);
    expect(settingsDifferences(backup, config, presets, {}, measured)).toEqual(
      expect.arrayContaining(['hw.led.total', 'hw.led.ins']),
    );
  });
});
