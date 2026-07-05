import { Platform } from 'react-native';
import { type Device, type Characteristic } from 'react-native-ble-plx';
import {
  ROGUE_TIMER_SERVICE_UUID,
  ROGUE_TIMER_CHARACTERISTIC_UUID,
  ROGUE_TIMER_ADVERTISED_SERVICE_UUID,
  buildRogueTimerFrame,
  isRogueTimerName,
  detectRogueDeviceType,
  type RogueTimerCommandCode,
} from '@boardsesh/ble-protocol/rogue-timer';
import { SCAN_TIMEOUT_MS } from '@boardsesh/ble-protocol/scan-constants';
import { bleManager } from './ble-manager';
import { uint8ArrayToBase64 } from './base64';
import { waitForBlePoweredOn } from './availability';
import { requestBleRuntimePermissions } from './use-ble-permissions';
import type { DiscoveredDevice } from './types';

// Purpose-built controller for the Rogue Fitness workout timer (Home Timer 2.0
// / Echo Gym Timer 2.0). Reuses the app's shared `bleManager` singleton and
// mirrors the board adapter's connect/write mechanics, but is deliberately NOT
// the board-centric `BluetoothAdapter` — the timer is a fire-and-forget
// key-code peripheral, so this is a small write-only driver. The pure protocol
// (frames, UUIDs, name matching) lives in `@boardsesh/ble-protocol/rogue-timer`.
//
// Write-only by design: the `ffe1` characteristic can notify status echoes, but
// we never subscribe — driving the timer needs no ACK (spec §5/§7/§8).

// Connect timeout mirrors the board adapter's 12s window (a timer that's
// powered off or out of range shouldn't hang the caller indefinitely).
const CONNECTION_TIMEOUT_MS = 12_000;
// How long `connectByName` scans for the stored timer before giving up. Short
// enough to surface a missing timer quickly; the timer advertises within a
// second or two when it's on.
const CONNECT_BY_NAME_SCAN_TIMEOUT_MS = 10_000;
// Android needs MTU negotiation + a high-priority connection settled before the
// first write; a short settle delay mirrors the board adapter's ordering.
const ANDROID_SETTLE_DELAY_MS = 200;
// ATT MTU requested on Android. The frames are 4 bytes, so the default 23 is
// plenty — but requesting the board adapter's 517 up front keeps the negotiated
// link consistent and costs nothing for a peripheral that ignores it.
const REQUESTED_ATT_MTU = 517;
// react-native-ble-plx connection priority: 1 = High (low-latency), matching
// the board adapter's request for snappy button presses.
const CONNECTION_PRIORITY_HIGH = 1;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Find the Rogue timer's write characteristic (`ffe1` on service `ffe0`),
 * case-insensitively. Returns undefined when the service is absent —
 * react-native-ble-plx throws for a missing service — so the caller can fail
 * with a clear message instead of an opaque throw. Mirrors the board adapter's
 * `findWriteCharacteristic`.
 */
async function findTimerCharacteristic(device: Device): Promise<Characteristic | undefined> {
  try {
    const characteristics = await device.characteristicsForService(ROGUE_TIMER_SERVICE_UUID);
    return characteristics.find(
      (characteristic) => characteristic.uuid.toLowerCase() === ROGUE_TIMER_CHARACTERISTIC_UUID.toLowerCase(),
    );
  } catch {
    return undefined;
  }
}

export type RogueTimerConnection = {
  deviceId: string;
  deviceName?: string;
};

// A scan candidate we're willing to treat as a drivable timer: a Rogue/Echo
// device (spec §3 name match) that classifies as a timer, not Echo cardio
// (rower/bike/skier), which share the `echo` name but speak a different
// protocol. The FFE0 service filter already excludes most cardio, but the name
// gate is the belt-and-braces so a stray FFE0-advertising Echo unit can't be
// listed or connected as a timer.
function isDrivableTimer(name: string | null | undefined): boolean {
  return isRogueTimerName(name) && detectRogueDeviceType(name) === 'timer';
}

export class RogueTimerController {
  private connectedDevice: Device | null = null;
  private writeCharacteristic: Characteristic | null = null;
  // Internal subscription that clears cached refs on an unsolicited drop, so a
  // stale characteristic can never be written after the link is gone.
  private disconnectSubscription: { remove: () => void } | null = null;
  private connectedDeviceName: string | undefined;

  /**
   * Start a service-filtered scan for Rogue timers. Keeps a de-duped list (by
   * deviceId) of candidates whose advertised name passes `isRogueTimerName`,
   * pushing the growing list to `onUpdate` as devices arrive. Self-stops after
   * `SCAN_TIMEOUT_MS` (firing `onScanStopped`). Returns a stop function that
   * halts the scan immediately.
   *
   * Gating (permissions + radio powered-on) is async, so the scan starts on a
   * later tick; the returned stop function is safe to call before then — it
   * flags the scan as cancelled so it never starts.
   *
   * Known contention: `bleManager` is a shared singleton and react-native-ble-plx
   * allows only one scan at a time — a `connectByName` (runtime reconnect) scan
   * started while this pairing scan is open would replace it. In practice the two
   * don't overlap (pairing runs on the board-edit screen; reconnect runs on the
   * play screen with the board LED already connected), so this is left un-serialized.
   */
  scanForTimers(onUpdate: (devices: DiscoveredDevice[]) => void, onScanStopped?: () => void): () => void {
    const devices = new Map<string, DiscoveredDevice>();
    let stopped = false;
    let scanTimeoutId: ReturnType<typeof setTimeout> | undefined;

    const stopScan = () => {
      if (stopped) return;
      stopped = true;
      if (scanTimeoutId) clearTimeout(scanTimeoutId);
      void bleManager.stopDeviceScan();
    };

    void (async () => {
      // Android needs runtime BLE permissions; iOS prompts on first scan.
      const permitted = await requestBleRuntimePermissions();
      if (!permitted || stopped) return;
      const poweredOn = await waitForBlePoweredOn();
      if (!poweredOn || stopped) return;

      void bleManager.startDeviceScan([ROGUE_TIMER_ADVERTISED_SERVICE_UUID], null, (scanError, scannedDevice) => {
        if (scanError) {
          stopScan();
          return;
        }
        if (!scannedDevice) return;

        const deviceName = scannedDevice.localName ?? scannedDevice.name ?? undefined;
        // The service filter narrows to FFE0 advertisers; the name check keeps
        // only genuine Rogue/Echo *timers* off that (shared, generic HM-10) UUID
        // — Echo cardio equipment is excluded.
        if (!isDrivableTimer(deviceName)) return;

        const device: DiscoveredDevice = {
          deviceId: scannedDevice.id,
          name: deviceName,
          rssi: scannedDevice.rssi ?? -100,
        };
        const existing = devices.get(device.deviceId);
        // Upsert; only push when the list actually changes (new device or a
        // refreshed RSSI) so the picker isn't re-rendered on every duplicate.
        if (!existing || existing.rssi !== device.rssi || existing.name !== device.name) {
          devices.set(device.deviceId, device);
          onUpdate([...devices.values()]);
        }
      });

      scanTimeoutId = setTimeout(() => {
        stopScan();
        onScanStopped?.();
      }, SCAN_TIMEOUT_MS);
    })();

    return stopScan;
  }

  /**
   * Connect to a timer by its BLE peripheral id, negotiate the link, discover
   * services, and cache the `ffe1` write characteristic. On Android the MTU and
   * high-priority connection are settled before the first write (iOS handles
   * both automatically; the calls are safe no-ops there). Mirrors the board
   * adapter's connect flow.
   */
  async connectById(deviceId: string): Promise<RogueTimerConnection> {
    // Tear down any prior connection first: switching the paired timer (A → B)
    // must not leak A's OS link or leave A's disconnect listener registered —
    // that stale listener would otherwise fire later and wipe B's live refs.
    await this.teardownConnection();

    let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const connected = await Promise.race([
      bleManager.connectToDevice(deviceId),
      new Promise<never>((_resolve, reject) => {
        connectionTimeoutId = setTimeout(() => {
          bleManager.cancelDeviceConnection(deviceId).catch(() => {});
          reject(new Error('Connection timed out — timer may be powered off'));
        }, CONNECTION_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (connectionTimeoutId != null) clearTimeout(connectionTimeoutId);
    });

    // From here the OS link is established; any failure must cancel it so a
    // discovery/negotiation throw can't leave an untracked dangling connection.
    try {
      // Android: negotiate MTU + a high-priority connection before service
      // discovery, then let the link settle. iOS negotiates automatically.
      if (Platform.OS === 'android') {
        try {
          await connected.requestMTU(REQUESTED_ATT_MTU);
        } catch {
          // Negotiation failing is non-fatal for 4-byte frames.
        }
        try {
          await connected.requestConnectionPriority(CONNECTION_PRIORITY_HIGH);
        } catch {
          // Priority is a hint; ignore if the platform refuses it.
        }
        await delay(ANDROID_SETTLE_DELAY_MS);
      }

      const deviceWithServices = await connected.discoverAllServicesAndCharacteristics();
      const writeCharacteristic = await findTimerCharacteristic(deviceWithServices);
      if (!writeCharacteristic) {
        throw new Error('Rogue timer write characteristic (ffe1) not found');
      }

      this.connectedDevice = deviceWithServices;
      this.writeCharacteristic = writeCharacteristic;
      this.connectedDeviceName = deviceWithServices.localName ?? deviceWithServices.name ?? undefined;

      // Clear cached refs on an unsolicited drop so `pressButton` can't write a
      // dead characteristic. External listeners subscribe separately via
      // `onDisconnect`.
      this.disconnectSubscription = bleManager.onDeviceDisconnected(deviceId, () => {
        this.connectedDevice = null;
        this.writeCharacteristic = null;
        this.connectedDeviceName = undefined;
        this.disconnectSubscription?.remove();
        this.disconnectSubscription = null;
      });

      return { deviceId, deviceName: this.connectedDeviceName };
    } catch (error) {
      await bleManager.cancelDeviceConnection(deviceId).catch(() => {});
      throw error;
    }
  }

  /**
   * Pair by stored name: BLE peripheral ids aren't portable across phones, so a
   * remembered timer is re-found by scanning briefly for its advertised name.
   * Prefers an exact name match, otherwise any Rogue/Echo timer whose name
   * includes the stored string, picking the strongest RSSI, then connects by
   * id. Rejects if nothing matches within the scan window.
   */
  async connectByName(name: string): Promise<RogueTimerConnection> {
    const target = name.trim().toLowerCase();
    const candidates = new Map<string, DiscoveredDevice>();

    const permitted = await requestBleRuntimePermissions();
    if (!permitted) throw new Error('Bluetooth permission denied');
    const poweredOn = await waitForBlePoweredOn();
    if (!poweredOn) throw new Error('Bluetooth is not powered on');

    let scanTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let resolved = false;
    try {
      const found = await new Promise<DiscoveredDevice>((resolve, reject) => {
        const settleWith = (device: DiscoveredDevice) => {
          if (resolved) return;
          resolved = true;
          resolve(device);
        };

        void bleManager.startDeviceScan([ROGUE_TIMER_ADVERTISED_SERVICE_UUID], null, (scanError, scannedDevice) => {
          if (scanError) {
            if (!resolved) reject(new Error(`BLE scan failed: ${scanError.message}`));
            return;
          }
          if (!scannedDevice) return;

          const deviceName = scannedDevice.localName ?? scannedDevice.name ?? undefined;
          if (!isDrivableTimer(deviceName)) return;

          const lowerName = deviceName?.trim().toLowerCase();
          const candidate: DiscoveredDevice = {
            deviceId: scannedDevice.id,
            name: deviceName,
            rssi: scannedDevice.rssi ?? -100,
          };
          candidates.set(candidate.deviceId, candidate);

          // Exact name match is the confident case — take it immediately.
          if (lowerName === target) {
            settleWith(candidate);
          }
        });

        scanTimeoutId = setTimeout(() => {
          if (resolved) return;
          // No exact match surfaced. Fall back to the strongest-RSSI timer whose
          // name includes the stored string.
          let best: DiscoveredDevice | undefined;
          for (const candidate of candidates.values()) {
            if (!candidate.name?.trim().toLowerCase().includes(target)) continue;
            if (!best || candidate.rssi > best.rssi) best = candidate;
          }
          if (best) {
            settleWith(best);
          } else {
            resolved = true;
            reject(new Error(`No Rogue timer matching "${name}" found within scan window`));
          }
        }, CONNECT_BY_NAME_SCAN_TIMEOUT_MS);
      });
      // Stop the scan the moment the timer is resolved — scanning through the
      // (up to 12s) connect window degrades Android connection reliability.
      if (scanTimeoutId) clearTimeout(scanTimeoutId);
      void bleManager.stopDeviceScan();
      return await this.connectById(found.deviceId);
    } finally {
      // Safety net: idempotent stop for the reject/throw paths too.
      if (scanTimeoutId) clearTimeout(scanTimeoutId);
      void bleManager.stopDeviceScan();
    }
  }

  /**
   * Send a single remote button press: build the 4-byte frame, base64-encode
   * it, and write to the cached `ffe1` characteristic. Uses
   * write-without-response (the timer is fire-and-forget, spec §5), falling back
   * to write-with-response if the platform rejects the no-response write.
   */
  async pressButton(code: RogueTimerCommandCode): Promise<void> {
    const characteristic = this.writeCharacteristic;
    if (!characteristic) {
      throw new Error('Not connected to a Rogue timer');
    }

    const base64Frame = uint8ArrayToBase64(buildRogueTimerFrame(code));
    try {
      await characteristic.writeWithoutResponse(base64Frame);
    } catch {
      // Some peripherals/platforms under-report write-without-response support;
      // fall back to the acknowledged write so the press still lands.
      await characteristic.writeWithResponse(base64Frame);
    }
  }

  /** Disconnect the timer and clear cached refs. */
  async disconnect(): Promise<void> {
    await this.teardownConnection();
  }

  /**
   * Drop the current connection (if any): remove the disconnect subscription,
   * clear cached refs, and cancel the OS link. Shared by `disconnect()` and by
   * `connectById` (so a reconnect/timer-switch can't leak the prior link). Refs
   * are cleared before the async cancel so a concurrent `pressButton` can't
   * write a characteristic that's on its way out.
   */
  private async teardownConnection(): Promise<void> {
    // Release the shared bleManager's scan slot: a `connectByName` may be
    // mid-scan when the board LED drops and the provider calls `disconnect()`
    // (e.g. the timer dropped at the same moment). Without this, that scan holds
    // the singleton's single scan slot for up to CONNECT_BY_NAME_SCAN_TIMEOUT_MS
    // and a board reconnect scan started in that window would fail or be
    // silently replaced. Idempotent — safe when nothing is scanning.
    void bleManager.stopDeviceScan();

    if (this.disconnectSubscription) {
      this.disconnectSubscription.remove();
      this.disconnectSubscription = null;
    }

    const device = this.connectedDevice;
    this.connectedDevice = null;
    this.writeCharacteristic = null;
    this.connectedDeviceName = undefined;
    if (device) {
      try {
        await bleManager.cancelDeviceConnection(device.id);
      } catch {
        // Device may already be disconnected.
      }
    }
  }

  /**
   * Subscribe to unsolicited disconnects of the currently connected timer.
   * Returns an unsubscribe function. No-op (and a no-op unsubscribe) when not
   * connected, since there's no peripheral id to watch.
   */
  onDisconnect(callback: () => void): () => void {
    const device = this.connectedDevice;
    if (!device) return () => {};
    const subscription = bleManager.onDeviceDisconnected(device.id, () => callback());
    return () => subscription.remove();
  }

  isConnected(): boolean {
    return this.writeCharacteristic != null;
  }

  get deviceName(): string | undefined {
    return this.connectedDeviceName;
  }
}
