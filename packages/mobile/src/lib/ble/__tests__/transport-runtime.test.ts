import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BluetoothTransportRuntime } from '../transport-runtime';
import { RecordingBleAdapter } from '../../../dev/integration/RecordingBleAdapter';

const native = vi.hoisted(() => ({
  addListener: vi.fn(),
  getConnectedDevice: vi.fn(),
  disconnect: vi.fn(),
  disconnectKeepingBoard: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, PermissionsAndroid: { PERMISSIONS: {} } }));
vi.mock('../adapter', () => ({ RNBleAdapter: class {} }));
vi.mock('../native-ios-adapter', () => ({
  NativeIosBleAdapter: class {},
  nativeBleSupportsBoard: () => true,
  nativeBleSupportsConnectionAdoption: () => true,
  nativeBleSupportsPreparedConnections: () => true,
}));
vi.mock('../../../../modules/live-activity/src/index', () => ({ boardBleNative: native }));
vi.mock('../ble-manager', () => ({
  getBleManager: () => {
    throw new Error('Native radio must remain untouched');
  },
}));
vi.mock('../bluetooth-authorization', () => ({
  readBluetoothAuthorization: () => {
    throw new Error('Native authorization must remain untouched');
  },
}));
vi.mock('../background-safe-timeout', () => ({ setBackgroundSafeTimeout: vi.fn() }));
vi.mock('react-native-ble-plx', () => ({ State: { PoweredOn: 'PoweredOn' } }));
const runtime = (): BluetoothTransportRuntime => ({
  createAdapter: (_picker, family, options) => new RecordingBleAdapter(family, options),
  waitForPoweredOn: vi.fn(async () => true),
  requestPermissions: vi.fn(async () => 'granted' as const),
  discovery: 'external',
  widgetCommandDelivery: 'javascript',
});
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
describe('injected Bluetooth transport lifecycle', () => {
  it('keeps production transport as the default and refuses changing a running app', async () => {
    const transport = await import('../transport-runtime');
    expect(transport.bluetoothTransport()).toBeUndefined();
    expect(() => transport.installBluetoothTransport(runtime())).toThrow('before application startup');
  });
  it('allows idempotent preparation but forbids transport replacement', async () => {
    const transport = await import('../transport-runtime');
    const selected = runtime();
    transport.installBluetoothTransport(selected);
    transport.installBluetoothTransport(selected);
    expect(transport.bluetoothTransport()).toBe(selected);
    expect(() => transport.installBluetoothTransport(runtime())).toThrow('before application startup');
  });
  it('delegates connection and isolates native adoption, pairing and permissions', async () => {
    const transport = await import('../transport-runtime');
    const selected = runtime();
    transport.installBluetoothTransport(selected);
    const factory = await import('../adapter-factory');
    const adapter = factory.createBluetoothAdapter(async () => '', 'aurora', { boardName: 'tension' });
    expect(adapter).toBeInstanceOf(RecordingBleAdapter);
    expect(factory.isNativeIosBleAdapter(adapter)).toBe(false);
    expect(factory.subscribeNativeBleConnected(vi.fn())).toBeNull();
    expect(await factory.getNativeBleConnectedDevice()).toBeNull();
    expect(await factory.forgetNativeKeptBoard()).toBe(false);
    expect(native.addListener).not.toHaveBeenCalled();
    expect(native.getConnectedDevice).not.toHaveBeenCalled();
    expect(native.disconnect).not.toHaveBeenCalled();
    const availability = await import('../availability');
    expect(await availability.waitForBlePoweredOn()).toBe(true);
    const permissions = await import('../use-ble-permissions');
    expect(await permissions.requestBleRuntimePermissionStatus()).toBe('granted');
    expect(selected.waitForPoweredOn).toHaveBeenCalled();
    expect(selected.requestPermissions).toHaveBeenCalled();
  });
  it('never persists transient device identities and honors disconnects and aborts', async () => {
    const adapter = new RecordingBleAdapter('aurora', { boardName: 'kilter' });
    expect(adapter.persistConnection).toBe(false);
    await expect(adapter.write(new Uint8Array([1]))).rejects.toThrow('Not connected');
    const connected = await adapter.requestAndConnect();
    expect(connected.deviceName).toBe('Kilter Board@3');
    await expect(adapter.write(new Uint8Array([1]))).resolves.toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    await expect(adapter.write(new Uint8Array([1]), aborted.signal)).rejects.toThrow('Write aborted');
    await adapter.disconnect();
    await expect(adapter.write(new Uint8Array([1]))).rejects.toThrow('Not connected');
  });
});
