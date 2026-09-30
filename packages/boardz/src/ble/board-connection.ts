import { State, type Characteristic, type Device, type Subscription } from 'react-native-ble-plx';
import {
  REDBEARLAB_SERVICE_UUID,
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  splitMessages,
} from '@boardsesh/ble-protocol';
import { bytesToBase64 } from './base64';
import { getBleManager } from './ble-manager';
import { isLikelyBoardDevice, type BoardFamily } from './device-filter';
import { writePlan } from './write-plan';

// Transport rules copied from Boardsesh's proven ble-plx adapter
// (packages/mobile/src/lib/ble/adapter.ts).
const CONNECT_TIMEOUT_MS = 12_000;
// ATT 247 (244-byte chunks) for Aurora; bigger MTUs misbehave on some iOS versions.
const REQUESTED_ATT_MTU = 247;
const DEFAULT_ATT_MTU = 23;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type DiscoveredBoard = { id: string; name: string | null; rssi: number };

/**
 * Scan for boards of one family until the returned function is called. Scans
 * unfiltered and matches in JS, because some controllers only advertise their
 * name, which a service-UUID filter never sees.
 */
export function scanForBoards(
  family: BoardFamily,
  onDevices: (devices: DiscoveredBoard[]) => void,
  onError: (message: string) => void,
): () => void {
  const manager = getBleManager();
  const found = new Map<string, DiscoveredBoard>();
  void manager
    .startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
      if (error) {
        onError(error.message);
        return;
      }
      if (!device) return;
      const name = device.localName ?? device.name ?? null;
      const serviceUuids = [...(device.serviceUUIDs ?? []), ...(device.overflowServiceUUIDs ?? [])];
      if (!isLikelyBoardDevice({ name, serviceUuids, family })) return;
      const previous = found.get(device.id);
      // With allowDuplicates the same advert repeats constantly; only report news.
      if (previous && (previous.name !== null || name === null)) return;
      found.set(device.id, { id: device.id, name: name ?? previous?.name ?? null, rssi: device.rssi ?? -100 });
      onDevices([...found.values()]);
    })
    .catch((error: unknown) => onError(error instanceof Error ? error.message : 'Bluetooth scan failed.'));
  return () => {
    void manager.stopDeviceScan().catch(() => {});
  };
}

async function findWriteCharacteristic(
  device: Device,
  serviceUuid: string,
  characteristicUuid: string,
): Promise<Characteristic | undefined> {
  try {
    const characteristics = await device.characteristicsForService(serviceUuid);
    return characteristics.find(
      (characteristic) => characteristic.uuid.toLowerCase() === characteristicUuid.toLowerCase(),
    );
  } catch {
    // ble-plx throws when the service is absent.
    return undefined;
  }
}

/** A live Bluetooth link to one board controller. */
export class BoardConnection {
  private characteristic: Characteristic | null = null;
  private subscriptions: Subscription[] = [];
  private mtu = DEFAULT_ATT_MTU;
  private writeChain: Promise<void> = Promise.resolve();
  private latestWrite = 0;
  private closed = false;
  private name: string | null;

  constructor(
    readonly deviceId: string,
    deviceName: string | null,
    private readonly family: BoardFamily,
    private readonly onDropped: () => void,
  ) {
    this.name = deviceName;
  }

  /** The controller's advertised name. Aurora packets take their version from it. */
  get deviceName(): string | null {
    return this.name;
  }

  get isConnected(): boolean {
    return this.characteristic !== null;
  }

  async connect(): Promise<void> {
    const manager = getBleManager();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connected = await Promise.race([
      manager.connectToDevice(this.deviceId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void manager.cancelDeviceConnection(this.deviceId).catch(() => {});
          reject(new Error('The board did not answer. Check it is switched on and close by.'));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    // A scan can report a board before its name arrives; the link knows it.
    this.name ??= connected.localName ?? connected.name ?? null;

    // Only Aurora boxes take bigger writes. MoonBoard and Woods controllers stay on
    // 20-byte chunks, and the original MoonBoard LED box is old enough that fewer
    // GATT operations are safer.
    if (this.family === 'aurora') {
      try {
        this.mtu = (await connected.requestMTU(REQUESTED_ATT_MTU)).mtu || DEFAULT_ATT_MTU;
      } catch {
        this.mtu = connected.mtu || DEFAULT_ATT_MTU;
      }
    }

    const device = await connected.discoverAllServicesAndCharacteristics();
    let characteristic = await findWriteCharacteristic(device, UART_SERVICE_UUID, UART_WRITE_CHARACTERISTIC_UUID);
    if (!characteristic && this.family === 'moonboard') {
      characteristic = await findWriteCharacteristic(
        device,
        REDBEARLAB_SERVICE_UUID,
        REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
      );
    }
    if (!characteristic) {
      await manager.cancelDeviceConnection(this.deviceId).catch(() => {});
      throw new Error('This device does not accept climbs over Bluetooth.');
    }
    // Disconnected while connecting (the climber switched boards): stay closed.
    if (this.closed) throw new Error('Connection cancelled.');

    this.characteristic = characteristic;
    this.subscriptions = [
      manager.onDeviceDisconnected(this.deviceId, () => this.drop()),
      // When Bluetooth goes off, iOS can end every link without reporting each
      // disconnect, so any state but on counts as a dropped link.
      manager.onStateChange((state) => {
        if (state !== State.PoweredOn) this.drop();
      }, false),
    ];
  }

  /**
   * Send a packet. Writes run one at a time so two packets never interleave,
   * and a packet still waiting when a newer one arrives is skipped: the wall
   * only needs the latest climb.
   */
  write(packet: Uint8Array): Promise<void> {
    const ticket = ++this.latestWrite;
    const run = this.writeChain.then(() => (ticket === this.latestWrite ? this.writeNow(packet) : undefined));
    this.writeChain = run.catch(() => {});
    return run;
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.release();
    await getBleManager()
      .cancelDeviceConnection(this.deviceId)
      .catch(() => {});
  }

  private release(): void {
    this.characteristic = null;
    for (const subscription of this.subscriptions) subscription.remove();
    this.subscriptions = [];
  }

  /** The link went away without the climber asking. */
  private drop(): void {
    if (!this.characteristic) return;
    this.release();
    void getBleManager()
      .cancelDeviceConnection(this.deviceId)
      .catch(() => {});
    this.onDropped();
  }

  private async writeNow(packet: Uint8Array): Promise<void> {
    const characteristic = this.characteristic;
    if (!characteristic) throw new Error('The board is not connected.');
    const plan = writePlan({
      family: this.family,
      deviceName: this.name,
      mtu: this.mtu,
      writableWithoutResponse: characteristic.isWritableWithoutResponse,
    });
    const chunks = splitMessages(packet, plan.chunkSize);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      if (chunkIndex > 0) await delay(plan.chunkDelayMs);
      const current = this.characteristic;
      if (!current) throw new Error('The board disconnected.');
      const chunk = bytesToBase64(chunks[chunkIndex]);
      try {
        if (plan.withoutResponse) await current.writeWithoutResponse(chunk);
        else await current.writeWithResponse(chunk);
      } catch (error) {
        // A failed write can be the only sign the link is gone, so check the
        // link before blaming the write.
        const stillConnected = await getBleManager()
          .isDeviceConnected(this.deviceId)
          .catch(() => false);
        if (!stillConnected) {
          this.drop();
          throw new Error('The board disconnected.');
        }
        throw error;
      }
    }
  }
}
