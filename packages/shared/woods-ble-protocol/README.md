# @boardsesh/woods-ble-protocol

Encode routes and open BLE sessions for compatible Woods Board controllers. This package owns the wire-role constants and physical LED maps for the 8×10 and 12×12 boards. It depends only on `@boardsesh/ble-core`.

## Connect and light holds

Supply a `BleConnector` for your BLE library. The connector handles permissions, scanning, selection, and the platform connection deadline. Its characteristic writes must submit exactly one ATT payload; do not wrap a native whole-message writer that chunks internally.

```ts
import { connectBoard, type BleConnector } from '@boardsesh/ble-core';
import { createWoodsProtocol, getWoodsSerialPosition } from '@boardsesh/woods-ble-protocol';

async function lightRoute(connector: BleConnector, selectedDeviceId: string) {
  const board = await connectBoard(createWoodsProtocol({ size: '12x12' }), connector, selectedDeviceId);
  try {
    await board.show([
      { index: getWoodsSerialPosition(0, '12x12'), role: 'start' },
      { index: getWoodsSerialPosition(5, '12x12'), role: 'hand' },
      { index: getWoodsSerialPosition(7, '12x12'), role: 'finish' },
    ]);
  } finally {
    await board.disconnect();
  }
}
```

`getWoodsSerialPosition()` maps the vendor's `baseHoldLocation` into a zero-based physical LED address. `show()` accepts those physical addresses with `start`, `hand`, `foot`, or `finish` roles. The controller chooses colors; RGB input is rejected. Empty `show()` input is rejected so malformed routes cannot silently clear the board. Call `clear()` to send the explicit `,!` command.

Sessions snapshot submitted inputs, serialize operations, and support cancellation and disconnect listeners. Closing a session releases the connection without clearing the lights. Pure `encodeWoodsPacket()` and `encodeWoodsClear()` support integrations that already own BLE delivery. Supply an optional `BleScheduler` for hosts requiring background-safe timers.

## Transport and maps

Woods uses Nordic UART with acknowledged writes, even when the characteristic advertises unacknowledged support. Messages are split into 20-byte chunks with 5 ms inter-chunk pacing. Unsupported write characteristics fail during initialization and release the connection.

The [protocol specification](docs/WOODS_BLUETOOTH_PROTOCOL_SPEC.md) and [source map JSON](docs/woods-board-led-maps/) are colocated here. The repository generator produces the TypeScript maps and native Swift maps from that one source; drift tests preserve parity. Catalog grades and rendering geometry stay outside this package. Animation and Aurora frame strings are not part of this API.

This is an independent compatibility implementation, not manufacturer-endorsed software. Licensed under [Apache-2.0](LICENSE). Publishing and release automation are managed separately from this source package.
