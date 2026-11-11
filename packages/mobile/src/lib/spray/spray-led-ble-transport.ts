import { Platform } from 'react-native';
import type { Device } from 'react-native-ble-plx';
import {
  BLE_LED_CONTROL_CHARACTERISTIC_UUID,
  BLE_LED_INFO_CHARACTERISTIC_UUID,
  BLE_LED_SERVICE_UUID,
  BLE_LED_STATUS_CHARACTERISTIC_UUID,
  DEFAULT_ATT_MTU,
  LedControllerError,
  type BleLedLink,
  type BleLedTransport,
} from '@boardsesh/led-controller';
import { getBleManager } from '../ble/ble-manager';
import { waitForBlePoweredOn } from '../ble/availability';
import { uint8ArrayToBase64 } from '../ble/base64';
import { requestBleRuntimePermissions } from '../ble/use-ble-permissions';

/**
 * The Spraywall's Bluetooth LED controller (docs/spray-wall-led-ble.md) over the
 * app's one ble-plx manager.
 *
 * Kept apart from the board stack on purpose: Kilter, Tension and MoonBoard run
 * through `BluetoothAdapter` (and on iOS a native manager), this only ever
 * touches the device ids it connected itself. It never stops another
 * connection; it scans only when the climber asks, or briefly when a route
 * needs a controller and the phone has none stored.
 */

const CONNECTION_TIMEOUT_MS = 12_000;
// The board adapter's choice: DLE-friendly, and well above a 40-run frame.
const REQUESTED_ATT_MTU = 247;
/** Let go after a minute without writes, so the next climber's phone can connect. */
export const SPRAY_LED_BLE_IDLE_MS = 60_000;
export const SPRAY_LED_BLE_SCAN_MS = 10_000;
const FIND_ONLY_SCAN_MS = 4_000;

export type SprayLedBleCandidate = { id: string; name: string; rssi: number };

type OpenLink = { device: Device; link: BleLedLink; idle: ReturnType<typeof setTimeout> | null };

const links = new Map<string, Promise<OpenLink>>();

function base64ToBytes(base64: string | null | undefined): Uint8Array {
  if (!base64) return new Uint8Array();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function ensureRadio(): Promise<void> {
  if (!(await requestBleRuntimePermissions())) throw new LedControllerError('unavailable');
  if (!(await waitForBlePoweredOn())) throw new LedControllerError('unavailable');
}

function forget(deviceId: string, open: OpenLink | null) {
  if (open?.idle) clearTimeout(open.idle);
  links.delete(deviceId);
}

function touch(deviceId: string, open: OpenLink) {
  if (open.idle) clearTimeout(open.idle);
  open.idle = setTimeout(() => {
    forget(deviceId, open);
    void getBleManager()
      .cancelDeviceConnection(deviceId)
      .catch(() => undefined);
  }, SPRAY_LED_BLE_IDLE_MS);
}

async function open(deviceId: string): Promise<OpenLink> {
  await ensureRadio();
  const manager = getBleManager();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let connected: Device;
  try {
    connected = await Promise.race([
      manager.connectToDevice(deviceId, { timeout: CONNECTION_TIMEOUT_MS }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new LedControllerError('timeout')), CONNECTION_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    void manager.cancelDeviceConnection(deviceId).catch(() => undefined);
    throw error instanceof LedControllerError ? error : new LedControllerError('unavailable');
  } finally {
    clearTimeout(timeout);
  }
  try {
    let device = connected;
    if (Platform.OS === 'android') {
      try {
        device = await connected.requestMTU(REQUESTED_ATT_MTU);
      } catch {
        // The default MTU still works: frames shrink to two runs.
      }
    }
    device = await device.discoverAllServicesAndCharacteristics();
    const statusListeners = new Set<(frame: Uint8Array) => void>();
    // Subscribing to the encrypted status characteristic is what makes the OS
    // ask for the controller's passkey the first time.
    const monitor = device.monitorCharacteristicForService(
      BLE_LED_SERVICE_UUID,
      BLE_LED_STATUS_CHARACTERISTIC_UUID,
      (error, characteristic) => {
        if (error || !characteristic?.value) return;
        const frame = base64ToBytes(characteristic.value);
        for (const listener of statusListeners) listener(frame);
      },
    );
    const mtu = device.mtu && device.mtu >= DEFAULT_ATT_MTU ? device.mtu : DEFAULT_ATT_MTU;
    const entry: OpenLink = {
      device,
      idle: null,
      link: {
        mtu,
        async readInfo() {
          touch(deviceId, entry);
          const characteristic = await device.readCharacteristicForService(
            BLE_LED_SERVICE_UUID,
            BLE_LED_INFO_CHARACTERISTIC_UUID,
          );
          return base64ToBytes(characteristic.value);
        },
        async writeControl(frame) {
          touch(deviceId, entry);
          await device.writeCharacteristicWithResponseForService(
            BLE_LED_SERVICE_UUID,
            BLE_LED_CONTROL_CHARACTERISTIC_UUID,
            uint8ArrayToBase64(frame),
          );
        },
        onStatus(listener) {
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
      },
    };
    const disconnected = manager.onDeviceDisconnected(deviceId, () => {
      disconnected.remove();
      monitor.remove();
      forget(deviceId, entry);
    });
    touch(deviceId, entry);
    return entry;
  } catch {
    void manager.cancelDeviceConnection(deviceId).catch(() => undefined);
    throw new LedControllerError('unavailable');
  }
}

export const sprayLedBleTransport: BleLedTransport = {
  async connect(deviceId) {
    let pending = links.get(deviceId);
    if (!pending) {
      pending = open(deviceId);
      links.set(deviceId, pending);
      pending.catch(() => {
        if (links.get(deviceId) === pending) links.delete(deviceId);
      });
    }
    const entry = await pending;
    touch(deviceId, entry);
    return entry.link;
  },
};

/**
 * List controllers advertising the service. Calls `onUpdate` with the growing
 * list and `onStopped` when the scan ends by itself. Returns the stop function.
 */
export function scanForSprayLedControllers(
  onUpdate: (candidates: SprayLedBleCandidate[]) => void,
  onStopped: (outcome: 'done' | 'unavailable') => void,
  durationMs = SPRAY_LED_BLE_SCAN_MS,
): () => void {
  const found = new Map<string, SprayLedBleCandidate>();
  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    // Before the gating finished there is no scan, and touching the manager
    // would create it (and on iOS ask for Bluetooth).
    if (started) void getBleManager().stopDeviceScan();
  };
  void (async () => {
    try {
      await ensureRadio();
    } catch {
      if (!stopped) {
        stop();
        onStopped('unavailable');
      }
      return;
    }
    if (stopped) return;
    started = true;
    // The usermod puts the 128-bit service UUID in the advertising packet
    // itself, so a filtered scan finds it on Android and iOS alike.
    void getBleManager().startDeviceScan([BLE_LED_SERVICE_UUID], null, (error, device) => {
      if (stopped) return;
      if (error) {
        stop();
        onStopped('unavailable');
        return;
      }
      if (!device) return;
      const candidate = {
        id: device.id,
        name: device.localName ?? device.name ?? device.id,
        rssi: device.rssi ?? -100,
      };
      const previous = found.get(candidate.id);
      if (previous && previous.name === candidate.name) return;
      found.set(candidate.id, candidate);
      onUpdate([...found.values()]);
    });
    timer = setTimeout(() => {
      stop();
      onStopped('done');
    }, durationMs);
  })();
  return stop;
}

/** For a phone that never picked one: the controller, if exactly one is advertising nearby. */
export function findOnlySprayLedController(): Promise<SprayLedBleCandidate | null> {
  return new Promise((resolve) => {
    let latest: SprayLedBleCandidate[] = [];
    scanForSprayLedControllers(
      (candidates) => {
        latest = candidates;
      },
      (outcome) => resolve(outcome === 'done' && latest.length === 1 ? latest[0] : null),
      FIND_ONLY_SCAN_MS,
    );
  });
}
