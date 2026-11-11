import { Platform } from 'react-native';
import type { Device } from 'react-native-ble-plx';
import { isSprayLedControllerName } from '@boardsesh/ble-protocol';
import { UART_SERVICE_UUID, UART_WRITE_CHARACTERISTIC_UUID } from '@boardsesh/ble-protocol/transport';
import { LedControllerError, type BleLedLink, type BleLedTransport } from '@boardsesh/led-controller';
import { getBleManager } from '../ble/ble-manager';
import { waitForBlePoweredOn } from '../ble/availability';
import { uint8ArrayToBase64 } from '../ble/base64';
import { HIGH_POWER_BOARD_SCAN_OPTIONS } from '../ble/scan-options';
import { requestBleRuntimePermissions } from '../ble/use-ble-permissions';

/**
 * The Spraywall's Bluetooth LED controller (docs/spray-wall-led-ble.md): the
 * board-controller firmware's `gledopto-c015-spraywall` build, which takes
 * Aurora API v3 frames on the Nordic UART write characteristic, like a Kilter
 * board, with no pairing.
 *
 * Kept apart from the board stack on purpose: Kilter, Tension and MoonBoard run
 * through `BluetoothAdapter` (and on iOS a native manager); this only ever
 * touches the device ids it connected itself. It never stops another
 * connection, and scans only when the climber asks, or briefly when a route
 * needs a controller and the phone has none stored.
 */

const CONNECTION_TIMEOUT_MS = 12_000;
// The board adapter's choice: DLE-friendly, and chunks clamp to 244 anyway.
const REQUESTED_ATT_MTU = 247;
const DEFAULT_ATT_MTU = 23;
/** Let go after a minute without writes, so the next climber's phone can connect. */
export const SPRAY_LED_BLE_IDLE_MS = 60_000;
export const SPRAY_LED_BLE_SCAN_MS = 10_000;
const FIND_ONLY_SCAN_MS = 4_000;

export type SprayLedBleCandidate = { id: string; name: string; rssi: number };

type OpenLink = { link: BleLedLink; idle: ReturnType<typeof setTimeout> | null };

const links = new Map<string, Promise<OpenLink>>();

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
        // The default MTU still works: the packet goes out in 20-byte chunks.
      }
    }
    device = await device.discoverAllServicesAndCharacteristics();
    const characteristics = await device.characteristicsForService(UART_SERVICE_UUID);
    const write = characteristics.find(
      (characteristic) => characteristic.uuid.toLowerCase() === UART_WRITE_CHARACTERISTIC_UUID.toLowerCase(),
    );
    if (!write) throw new LedControllerError('not-wled');
    const mtu = device.mtu && device.mtu >= DEFAULT_ATT_MTU ? device.mtu : DEFAULT_ATT_MTU;
    const entry: OpenLink = {
      idle: null,
      link: {
        mtu,
        name: device.localName ?? device.name ?? '',
        async write(chunk) {
          touch(deviceId, entry);
          // With response: each chunk is acknowledged before the next, so no
          // pacing delay is needed and a lost chunk fails the send.
          await write.writeWithResponse(uint8ArrayToBase64(chunk));
        },
      },
    };
    const disconnected = manager.onDeviceDisconnected(deviceId, () => {
      disconnected.remove();
      forget(deviceId, entry);
    });
    touch(deviceId, entry);
    return entry;
  } catch (error) {
    void manager.cancelDeviceConnection(deviceId).catch(() => undefined);
    throw error instanceof LedControllerError ? error : new LedControllerError('unavailable');
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
 * List Spraywall controllers nearby. Calls `onUpdate` with the growing list
 * and `onStopped` when the scan ends by itself. Returns the stop function.
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
    // Unfiltered, matched by name: the controller advertises only its name
    // (no service UUID, so no board picker lists it), as the board pickers
    // match Kilter-built boxes by name.
    void getBleManager().startDeviceScan(null, HIGH_POWER_BOARD_SCAN_OPTIONS, (error, device) => {
      if (stopped) return;
      if (error) {
        stop();
        onStopped('unavailable');
        return;
      }
      const name = device?.localName ?? device?.name ?? null;
      if (!device || !name || !isSprayLedControllerName(name)) return;
      const candidate = { id: device.id, name: name.trim(), rssi: device.rssi ?? -100 };
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
