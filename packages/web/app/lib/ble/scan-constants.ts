// BLE scan timing constants now live in @boardsesh/ble-protocol so web and
// mobile share one source of truth. Re-exported here so existing web importers
// (capacitor / native-iOS adapters + tests) keep their local import path.
export { SERIAL_RECONNECT_GRACE_MS, SCAN_TIMEOUT_MS } from '@boardsesh/ble-protocol/scan-constants';
