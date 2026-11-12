import { AppState, Platform } from 'react-native';
import type { Device } from 'react-native-ble-plx';
import { isSprayLedControllerName } from '@boardsesh/ble-protocol/advertised-identity';
import { UART_SERVICE_UUID, UART_WRITE_CHARACTERISTIC_UUID } from '@boardsesh/ble-protocol/transport';
import { LedControllerError, type BleLedLink, type BleLedTransport } from '@boardsesh/led-controller';
import { getBleManager } from '../ble/ble-manager';
import { waitForBlePoweredOn } from '../ble/availability';
import { setBackgroundSafeTimeout } from '../ble/background-safe-timeout';
import { uint8ArrayToBase64 } from '../ble/base64';
import { currentBleScanOwner, noteBleScanStarted, releaseBleScan } from '../ble/ble-scan-slot';
import { HIGH_POWER_BOARD_SCAN_OPTIONS } from '../ble/scan-options';
import { requestBleRuntimePermissions } from '../ble/use-ble-permissions';
import { getPreference, removePreference, setPreference } from '../preference-store';
import { sprayLedBleDeviceIdKey } from './spray-wall-led-cache';

/**
 * The Spraywall's Bluetooth LED controller (docs/spray-wall-led-ble.md): the
 * board-controller firmware's `gledopto-c015-spraywall` build, which takes
 * Aurora API v3 frames on the Nordic UART write characteristic, like a Kilter
 * board, with no pairing.
 *
 * The wall saves the name the controller advertises; each phone finds its own
 * device id for that name by scanning (ids differ per phone) and remembers it.
 *
 * Kept apart from the board stack on purpose: Kilter, Tension and MoonBoard run
 * through `BluetoothAdapter` (and on iOS a native manager); this only ever
 * touches the device ids it connected itself, and scans only through the shared
 * scan slot (ble-scan-slot.ts), never over or instead of another scan.
 */

// Worst case of one connect: the remembered id (10 s), a name scan (5 s) and
// the id it found (10 s), plus discovery, stays inside the driver's 30 s.
const CONNECTION_TIMEOUT_MS = 10_000;
// The board adapter's choice: DLE-friendly, and chunks clamp to 244 anyway.
const REQUESTED_ATT_MTU = 247;
const DEFAULT_ATT_MTU = 23;
/** Let go after a minute without writes, so the next climber's phone can connect. */
export const SPRAY_LED_BLE_IDLE_MS = 60_000;
/**
 * In the background, let go this soon after the last write instead: a screen's
 * clear on leaving still goes out over the open link, and nothing holds the
 * controller once it has.
 */
export const SPRAY_LED_BLE_BACKGROUND_IDLE_MS = 2_000;
export const SPRAY_LED_BLE_SCAN_MS = 10_000;
/** Finding a known name: it advertises every few hundred milliseconds when on. */
export const SPRAY_LED_BLE_FIND_MS = 5_000;

export type SprayLedBleCandidate = { id: string; name: string; rssi: number };
export type SprayLedBleScanOutcome = 'done' | 'unavailable' | 'busy';

type OpenLink = { deviceId: string; link: BleLedLink; cancelIdle: (() => void) | null };

/** Open (or opening) links by controller name. */
const links = new Map<string, Promise<OpenLink>>();
/** The device id this phone found for each controller name, mirrored to storage. */
const knownIds = new Map<string, string>();
/** A device just picked from a scan, tried first and kept only once it answered. */
const hints = new Map<string, string>();

function release(name: string, entry: OpenLink) {
  entry.cancelIdle?.();
  entry.cancelIdle = null;
  if (links.has(name)) links.delete(name);
  void getBleManager()
    .cancelDeviceConnection(entry.deviceId)
    .catch(() => undefined);
}

// Background-safe: a plain timer stops on Android while the app is in the
// background, and one pocketed phone would hold the controller for everyone.
function touch(name: string, entry: OpenLink) {
  entry.cancelIdle?.();
  const idleMs = AppState.currentState === 'background' ? SPRAY_LED_BLE_BACKGROUND_IDLE_MS : SPRAY_LED_BLE_IDLE_MS;
  entry.cancelIdle = setBackgroundSafeTimeout(() => release(name, entry), idleMs);
}

/**
 * Leaving the app lets go of every Spraywall controller within a moment. The
 * lights stay as they are: only the connection is released, for the next
 * phone. Not at once: a screen that clears the wall as it goes to the
 * background (the LED settings preview) still sends that clear over the open
 * link, instead of connecting again from the background just to clear.
 */
let appStateWatch: { remove(): void } | null = null;
function watchAppState() {
  if (appStateWatch) return;
  appStateWatch = AppState.addEventListener('change', (next) => {
    if (next !== 'background') return;
    for (const [name, pending] of links) {
      void pending.then((entry) => touch(name, entry)).catch(() => undefined);
    }
  });
}

async function ensureRadio(): Promise<void> {
  // Off or not allowed: a different message from "the controller didn't answer".
  if (!(await requestBleRuntimePermissions())) throw new LedControllerError('bluetooth-unavailable');
  if (!(await waitForBlePoweredOn())) throw new LedControllerError('bluetooth-unavailable');
}

async function readKnownId(name: string): Promise<string | null> {
  const remembered = knownIds.get(name);
  if (remembered) return remembered;
  try {
    const stored = await getPreference<unknown>(sprayLedBleDeviceIdKey(name));
    if (typeof stored !== 'string' || !stored) return null;
    knownIds.set(name, stored);
    return stored;
  } catch {
    return null;
  }
}

/**
 * Try this device first for `name` on the next connect, without remembering
 * it: the section picks a scanned controller and remembers it only once the
 * controller answered (`rememberSprayLedController`).
 */
export function hintSprayLedController(name: string, deviceId: string): void {
  if (isSprayLedControllerName(name)) hints.set(name, deviceId);
}

/** Remember which device advertises `name` on this phone. Never uploaded. */
export async function rememberSprayLedController(name: string, deviceId: string): Promise<void> {
  if (!isSprayLedControllerName(name)) return;
  knownIds.set(name, deviceId);
  await setPreference(sprayLedBleDeviceIdKey(name), deviceId).catch(() => undefined);
}

function forgetKnownId(name: string) {
  knownIds.delete(name);
  void removePreference(sprayLedBleDeviceIdKey(name)).catch(() => undefined);
}

async function openDevice(name: string, deviceId: string): Promise<OpenLink> {
  const manager = getBleManager();
  let device: Device;
  try {
    // ble-plx times the attempt out itself.
    device = await manager.connectToDevice(deviceId, { timeout: CONNECTION_TIMEOUT_MS });
  } catch {
    void manager.cancelDeviceConnection(deviceId).catch(() => undefined);
    throw new LedControllerError('unavailable');
  }
  try {
    if (Platform.OS === 'android') {
      try {
        device = await device.requestMTU(REQUESTED_ATT_MTU);
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
      deviceId,
      cancelIdle: null,
      link: {
        mtu,
        name,
        async write(chunk) {
          touch(name, entry);
          // With response: each chunk is acknowledged before the next, so no
          // pacing delay is needed and a lost chunk fails the send.
          await write.writeWithResponse(uint8ArrayToBase64(chunk));
        },
      },
    };
    const disconnected = manager.onDeviceDisconnected(deviceId, () => {
      disconnected.remove();
      entry.cancelIdle?.();
      entry.cancelIdle = null;
      // Only this entry: a newer link to the same name stays.
      void links.get(name)?.then((current) => {
        if (current === entry) links.delete(name);
      });
    });
    touch(name, entry);
    return entry;
  } catch (error) {
    void manager.cancelDeviceConnection(deviceId).catch(() => undefined);
    throw error instanceof LedControllerError ? error : new LedControllerError('unavailable');
  }
}

/**
 * The device id remembered for this name, or else the one a short scan finds.
 *
 * A remembered id that does not connect is not forgotten on that alone: a
 * controller another phone is connected to stops advertising and refuses new
 * connections. The name is scanned for once; only when it shows up under a
 * different id (a replaced controller, a stale id) is the old id dropped. When
 * it does not show up, or shows up under the same id, the id stays and the
 * connect fails as unreachable.
 */
async function open(name: string): Promise<OpenLink> {
  await ensureRadio();
  watchAppState();
  const hinted = hints.get(name) ?? null;
  hints.delete(name);
  const tried = hinted ?? (await readKnownId(name));
  if (tried) {
    try {
      return await openDevice(name, tried);
    } catch (error) {
      if (error instanceof LedControllerError && error.code === 'not-wled') throw error;
    }
  }
  const found = await findSprayLedControllerByName(name);
  if (!found || found.id === tried) throw new LedControllerError('unavailable');
  if (tried && !hinted) forgetKnownId(name);
  const entry = await openDevice(name, found.id);
  // A hinted pick is remembered by its caller once it answered.
  if (!hinted) await rememberSprayLedController(name, found.id);
  return entry;
}

export const sprayLedBleTransport: BleLedTransport = {
  async connect(controllerName) {
    if (!isSprayLedControllerName(controllerName)) throw new LedControllerError('invalid-url');
    let pending = links.get(controllerName);
    if (!pending) {
      pending = open(controllerName);
      links.set(controllerName, pending);
      const opening = pending;
      opening.catch(() => {
        if (links.get(controllerName) === opening) links.delete(controllerName);
      });
    }
    const entry = await pending;
    touch(controllerName, entry);
    return entry.link;
  },
};

/**
 * List Spraywall controllers nearby. Calls `onUpdate` with the growing list
 * and `onStopped` when the scan ends by itself: `busy` when another scan holds
 * the slot (this never starts over it). Returns the stop function, which only
 * ever stops this scan.
 */
export function scanForSprayLedControllers(
  onUpdate: (candidates: SprayLedBleCandidate[]) => void,
  onStopped: (outcome: SprayLedBleScanOutcome) => void,
  durationMs = SPRAY_LED_BLE_SCAN_MS,
): () => void {
  const token = Symbol('spraywall-led-scan');
  const found = new Map<string, SprayLedBleCandidate>();
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelTimer?.();
    // Before the gating finished there is no scan, and touching the manager
    // would create it (and on iOS ask for Bluetooth). After another caller
    // took the slot, the running scan is theirs.
    if (releaseBleScan(token)) void getBleManager().stopDeviceScan();
  };
  const end = (outcome: SprayLedBleScanOutcome) => {
    if (stopped) return;
    stop();
    onStopped(outcome);
  };
  void (async () => {
    try {
      await ensureRadio();
    } catch {
      end('unavailable');
      return;
    }
    if (stopped) return;
    if (currentBleScanOwner() !== null) {
      end('busy');
      return;
    }
    noteBleScanStarted(token);
    // Unfiltered, matched by name: the controller advertises only its name
    // (no service UUID, so no board picker lists it), as the board pickers
    // match Kilter-built boxes by name.
    void getBleManager().startDeviceScan(null, HIGH_POWER_BOARD_SCAN_OPTIONS, (error, device) => {
      if (stopped) return;
      if (error) {
        end('unavailable');
        return;
      }
      const name = device?.localName ?? device?.name ?? null;
      if (!device || !isSprayLedControllerName(name)) return;
      const candidate = { id: device.id, name: name as string, rssi: device.rssi ?? -100 };
      const previous = found.get(candidate.id);
      if (previous && previous.name === candidate.name) return;
      found.set(candidate.id, candidate);
      onUpdate([...found.values()]);
    });
    cancelTimer = setBackgroundSafeTimeout(() => end('done'), durationMs);
  })();
  return stop;
}

/** The device advertising exactly `name`, found by a short scan, or null. */
export function findSprayLedControllerByName(name: string): Promise<SprayLedBleCandidate | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stop = scanForSprayLedControllers(
      (candidates) => {
        const match = candidates.find((candidate) => candidate.name === name);
        if (!match || settled) return;
        settled = true;
        stop();
        resolve(match);
      },
      (outcome) => {
        if (settled) return;
        settled = true;
        if (outcome === 'unavailable') reject(new LedControllerError('bluetooth-unavailable'));
        else resolve(null);
      },
      SPRAY_LED_BLE_FIND_MS,
    );
  });
}

/** For tests: forget every link and remembered id held in memory. */
export function resetSprayLedBleTransportForTests(): void {
  links.clear();
  knownIds.clear();
  hints.clear();
  appStateWatch?.remove();
  appStateWatch = null;
}

/** Remember the device the open link to `name` uses, once it answered. Never uploaded. */
export async function keepSprayLedController(name: string): Promise<void> {
  const pending = links.get(name);
  if (!pending) return;
  try {
    const entry = await pending;
    await rememberSprayLedController(name, entry.deviceId);
  } catch {
    // Not connected after all: nothing to keep.
  }
}
