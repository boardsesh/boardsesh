import { describe, expect, it, vi } from 'vite-plus/test';
import { coordinateToHoldId } from '@/app/lib/moonboard-config';
import {
  getMoonboardBluetoothPacket,
  getMoonboardSerialPosition,
  MOONBOARD_REQUEST_DEVICE_OPTIONS,
} from '../bluetooth-moonboard';
import { splitMessages, REDBEARLAB_SERVICE_UUID, UART_SERVICE_UUID } from '../bluetooth-shared';

describe('MOONBOARD_REQUEST_DEVICE_OPTIONS', () => {
  // RequestDeviceOptions is a union without `filters` on the accept-all variant;
  // narrow to the filter shape this constant actually uses.
  const options = MOONBOARD_REQUEST_DEVICE_OPTIONS as {
    filters?: Array<{ services?: string[]; namePrefix?: string }>;
    optionalServices?: string[];
  };

  it('filters on each controller service SEPARATELY (OR), not both at once', () => {
    // The filters are load-bearing: a single { services: [UART, RedBearLab] }
    // entry would require a board to advertise BOTH (no real board does), so a
    // per-service entry is required for any MoonBoard to appear in the chooser.
    const serviceFilters = (options.filters ?? [])
      .map((filter) => filter.services)
      .filter((services): services is string[] => Array.isArray(services));
    expect(serviceFilters).toContainEqual([UART_SERVICE_UUID]);
    expect(serviceFilters).toContainEqual([REDBEARLAB_SERVICE_UUID]);
    // No single filter lists both services together.
    expect(serviceFilters).not.toContainEqual([UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID]);
  });

  it('lists both controller services in optionalServices so getPrimaryService can reach either', () => {
    expect(options.optionalServices).toEqual(expect.arrayContaining([UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID]));
  });
});

describe('getMoonboardSerialPosition', () => {
  it('maps representative holds to the controller strip order', () => {
    expect(getMoonboardSerialPosition(coordinateToHoldId('A1'))).toBe(0);
    expect(getMoonboardSerialPosition(coordinateToHoldId('A18'))).toBe(17);
    expect(getMoonboardSerialPosition(coordinateToHoldId('B18'))).toBe(18);
    expect(getMoonboardSerialPosition(coordinateToHoldId('B1'))).toBe(35);
    expect(getMoonboardSerialPosition(coordinateToHoldId('K1'))).toBe(180);
    expect(getMoonboardSerialPosition(coordinateToHoldId('K18'))).toBe(197);
  });
});

describe('getMoonboardBluetoothPacket', () => {
  it('encodes Moonboard frames as the controller ASCII payload', () => {
    const { packet } = getMoonboardBluetoothPacket('p1r42p2r43p198r44');

    expect(new TextDecoder().decode(packet)).toBe('l#S0,P35,E197#');
  });

  it('skips unsupported Moonboard hold state codes gracefully', () => {
    const { packet, skippedRoleCount, totalPlacements } = getMoonboardBluetoothPacket('p1r45');

    expect(new TextDecoder().decode(packet)).toBe('l##');
    expect(skippedRoleCount).toBe(1);
    expect(totalPlacements).toBe(1);
  });

  it('encodes valid holds and skips invalid role codes', () => {
    const { packet, skippedRoleCount, totalPlacements } = getMoonboardBluetoothPacket('p1r42p2r99');

    expect(new TextDecoder().decode(packet)).toBe('l#S0#');
    expect(skippedRoleCount).toBe(1);
    expect(totalPlacements).toBe(2);
  });

  it('skips invalid Moonboard hold ids and keeps the remaining payload', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { packet, skippedPositionCount } = getMoonboardBluetoothPacket('p1r42p999r43p198r44');

    expect(new TextDecoder().decode(packet)).toBe('l#S0,E197#');
    expect(skippedPositionCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith('[BLE] Skipped 1 MoonBoard holds with invalid ids for this payload');

    warnSpy.mockRestore();
  });

  it('can be split into 20-byte BLE chunks without changing the payload', () => {
    const { packet } = getMoonboardBluetoothPacket('p1r42p2r43p3r43p4r43p5r43p6r43p7r43p8r43p198r44');

    const chunks = splitMessages(packet);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])))).toBe(
      new TextDecoder().decode(packet),
    );
  });
});
