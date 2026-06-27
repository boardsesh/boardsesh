import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildBleDiagnosticsReport,
  clearBleDiagnosticsLog,
  getBleDiagnosticsEvents,
  recordBleEvent,
} from '../ble-diagnostics-log';

describe('ble-diagnostics-log', () => {
  beforeEach(() => {
    clearBleDiagnosticsLog();
  });

  it('returns null when nothing has been recorded', () => {
    expect(buildBleDiagnosticsReport()).toBeNull();
  });

  it('lists devices found and recent connection events', () => {
    recordBleEvent({ type: 'device_found', deviceId: 'dev-1', name: 'Kilter A1B2', rssi: -52 });
    recordBleEvent({
      type: 'connect_failure',
      boardName: 'kilter',
      failureCategory: 'board_not_found',
      message: 'timeout',
    });

    const report = buildBleDiagnosticsReport();
    expect(report).toContain('Devices found (1):');
    expect(report).toContain('Kilter A1B2');
    expect(report).toContain('id=dev-1');
    expect(report).toContain('rssi -52');
    expect(report).toContain('connect_failure kilter category=board_not_found');
  });

  it('renders the chosen write type and MTU on a successful connect', () => {
    recordBleEvent({
      type: 'connect_success',
      boardName: 'kilter',
      layoutId: 1,
      apiLevel: 3,
      deviceNamePresent: true,
      diagnostics: {
        chosenWriteType: 'withoutResponse',
        supportsWriteWithoutResponse: true,
        maxWriteWithoutResponse: 244,
      },
    });

    const report = buildBleDiagnosticsReport();
    expect(report).toContain('connect_success kilter/layout 1 api v3');
    expect(report).toContain('write=withoutResponse');
    expect(report).toContain('maxNoResp=244');
  });

  it('flags a connect with no advertised name', () => {
    recordBleEvent({ type: 'connect_success', boardName: 'kilter', deviceNamePresent: false });
    expect(buildBleDiagnosticsReport()).toContain('(no advertised name)');
  });

  it('dedupes the device list by id, keeping the latest rssi', () => {
    recordBleEvent({ type: 'device_found', deviceId: 'dev-1', name: 'Kilter A1B2', rssi: -70 });
    recordBleEvent({ type: 'device_found', deviceId: 'dev-1', name: 'Kilter A1B2', rssi: -40 });

    const report = buildBleDiagnosticsReport() ?? '';
    expect(report).toContain('Devices found (1):');
    expect(report).toContain('rssi -40');
    expect(report).not.toContain('rssi -70');
  });

  it('caps the buffer and evicts oldest events', () => {
    for (let index = 0; index < 60; index += 1) {
      recordBleEvent({ type: 'disconnect', boardName: `board-${index}`, kind: 'dropped' });
    }
    const events = getBleDiagnosticsEvents();
    expect(events.length).toBe(40);
    // Oldest (board-0..19) evicted; newest retained.
    expect(events[events.length - 1]).toMatchObject({ boardName: 'board-59' });
    expect(events.some((event) => 'boardName' in event && event.boardName === 'board-0')).toBe(false);
  });

  it('lists the event timeline newest first', () => {
    recordBleEvent({ type: 'send_failure', boardName: 'kilter', failureReason: 'write_timeout', message: 'a' });
    recordBleEvent({ type: 'disconnect', boardName: 'kilter', kind: 'stolen' });

    const report = buildBleDiagnosticsReport() ?? '';
    const disconnectIndex = report.indexOf('disconnect kilter (stolen)');
    const sendFailureIndex = report.indexOf('send_failure kilter reason=write_timeout');
    expect(disconnectIndex).toBeGreaterThan(-1);
    expect(sendFailureIndex).toBeGreaterThan(-1);
    expect(disconnectIndex).toBeLessThan(sendFailureIndex);
  });
});
