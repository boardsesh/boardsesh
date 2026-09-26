import type { DevicePickerFn, DevicePickerTargetSearch, DiscoveredDevice } from '../types';

/**
 * A targeted connect's picker for the adapter tests, recording what the adapter
 * tells it (#5658). Shared by the ble-plx and native iOS adapter suites, which
 * keep the same state machine in lockstep.
 */
export function recordingTargetPicker() {
  const record = {
    opened: 0,
    targetSearch: undefined as DevicePickerTargetSearch | undefined,
    searchEnded: 0,
    found: 0,
    scanStopped: 0,
    updates: [] as DiscoveredDevice[][],
    pick: (_deviceId: string) => {},
    cancel: (_error: Error) => {},
  };
  const picker: DevicePickerFn = (subscribe, targetSearch) => {
    record.opened += 1;
    record.targetSearch = targetSearch;
    return new Promise<string>((resolve, reject) => {
      record.pick = resolve;
      record.cancel = reject;
      subscribe(
        (devices) => record.updates.push(devices),
        () => {
          record.scanStopped += 1;
        },
        {
          onTargetSearchEnded: () => {
            record.searchEnded += 1;
          },
          onTargetFound: () => {
            record.found += 1;
            // What the real picker does on close: retire its own promise.
            reject(new Error('Device selection cancelled'));
          },
        },
      );
    });
  };
  return { picker, record };
}
