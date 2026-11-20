# @boardsesh/moonboard-ble-protocol

Control compatible MoonBoard LED controllers using physical LED addresses and named hold roles. The package has no React, catalog, native SDK, or browser dependency. It uses the transport contracts from `@boardsesh/ble-core`.

## Connect and light holds

Supply a `BleConnector` implemented for your BLE library. It owns permissions, scanning, device selection, and the platform connection deadline. Its characteristic writer accepts one raw ATT chunk, not a complete-message writer that chunks again.

```ts
import { connectBoard, type BleConnector } from '@boardsesh/ble-core';
import { createMoonboardProtocol, getMoonboardSerialPosition } from '@boardsesh/moonboard-ble-protocol';

async function lightRoute(connector: BleConnector, selectedDeviceId: string) {
  const board = await connectBoard(createMoonboardProtocol({ numRows: 18 }), connector, selectedDeviceId);
  try {
    await board.show([
      { index: getMoonboardSerialPosition(1), role: 'start' },
      { index: getMoonboardSerialPosition(2), role: 'hand' },
      { index: getMoonboardSerialPosition(198), role: 'finish' },
    ]);
  } finally {
    await board.disconnect();
  }
}
```

`show()` accepts a non-empty array of physical, zero-based LED indices. It snapshots inputs before queueing, rejects unsupported RGB and foot roles, and replaces the displayed route. `clear()` deliberately sends `l##`; `disconnect()` releases the connection without clearing. Use `onDisconnect()` to observe connection teardown. Calls accept an optional `AbortSignal`.

For a Mini, pass `numRows: 12` both to the protocol and `getMoonboardSerialPosition`. The mapper takes one-based, row-major hold IDs; `show()` does not map them a second time. Pure `encodeMoonboardPacket()` and `encodeMoonboardClear()` are available when an existing integration already owns packet delivery.

## Supported transport and limits

The protocol probes Nordic UART first, then the original RedBearLab service. It uses 20-byte chunks with 5 ms inter-chunk pacing and acknowledged writes when the characteristic lacks unacknowledged writes. Supply the optional `BleScheduler` when the host requires background-safe timers.

`lightAdjacentHolds: true` adds the community-firmware `~D` extension. It is opt-in, and official-controller support remains unverified. Clearing is verified against community firmware only. MoonBoard Pro authentication, PIN exchange, and the additional legacy service described in the research notes are **not implemented**.

See the [protocol specification](docs/MOONBOARD_BLUETOOTH_PROTOCOL_SPEC.md) for provenance and controller limitations. MoonBoard is a trademark of its owner; this is an independent compatibility implementation.

Licensed under [Apache-2.0](LICENSE). Publishing and release automation are managed separately from this source package.
