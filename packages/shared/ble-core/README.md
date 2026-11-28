# Portable board BLE connections

Platform-independent TypeScript contracts and session helpers for climbing board controllers. No React, Expo, browser globals, catalog, or Bluetooth SDK is required. Licensed under Apache-2.0. These workspace packages are being extracted for reuse; publication tooling is separate.

## Choose a protocol

| Package | Wire format | Lighting inputs |
| --- | --- | --- |
| `@boardsesh/aurora-ble-protocol` | Aurora v2/v3 | RGB; semantic roles with an explicit palette |
| `@boardsesh/kilter-ble-protocol` | Aurora with Kilter defaults | RGB; semantic roles with an explicit palette |
| `@boardsesh/moonboard-ble-protocol` | MoonBoard ASCII | Start, hand, finish |
| `@boardsesh/woods-ble-protocol` | Woods ASCII | Start, hand, foot, finish |
| `@boardsesh/wled-ble-protocol` | Framed JSON over the WLED BLE usermod | RGB; semantic roles with an explicit palette |

The packages describe compatibility and are not endorsed by board manufacturers. A device advertising Nordic UART is not enough to distinguish MoonBoard from Woods: the caller must select the correct protocol and controller.

## Connect an already selected device

```ts
import { connectBoard, type BleConnector } from '@boardsesh/ble-core';
import { createMoonboardProtocol } from '@boardsesh/moonboard-ble-protocol';

async function lightRoute(connector: BleConnector, deviceId: string) {
  const session = await connectBoard(createMoonboardProtocol(), connector, deviceId);
  try {
    await session.show([{ index: 0, role: 'start' }, { index: 17, role: 'finish' }]);
    await session.clear();
  } finally {
    await session.disconnect();
  }
}
```

`index` is a physical LED address, not a catalog placement ID. Family mapping helpers convert supported hold IDs. `show([])` rejects: use `clear()` deliberately. Unsupported colors, roles, and positions reject before lighting writes. A successful write means the transport accepted the command; write-only controllers do not confirm that physical LEDs lit.

## Implement the transport

Implement `BleConnector.connect(deviceId, signal)` using your platform SDK. It returns a connected `BleTransport` with characteristic discovery, disconnect notifications, and `disconnect()`. `maxWriteBytes` is the negotiated ATT payload limit, excluding the three-byte ATT header. Each characteristic's `write()` accepts **one raw ATT chunk**, with the specified acknowledged/unacknowledged mode. WLED additionally requires reads and subscriptions; `subscribe()` must resolve only when peripheral notifications are enabled.

The connector owns Bluetooth permissions, scan ownership, device selection, connect deadlines, and platform retries. Protocol discovery metadata is a hint for those operations, not a scanner. Normalize a missing service/characteristic to `BleError('service-missing')` so a family can try its alternate controller profile; other lookup errors propagate without fallback. The session owns framing, operation serialization, and teardown. `open()` takes connection ownership and closes it on failed initialization. `disconnect()` must settle only after this transport releases its subscriptions and radio ownership. Stable WLED controller IDs are distinct from platform device IDs and must be checked after reading capabilities.

Sessions copy submitted lights before queueing. Closing rejects pending work immediately; teardown is idempotent. An adapter must never replay a partially delivered message automatically. Platform writes may ignore cancellation; the queue retains physical operation ordering even when the caller's promise rejects early.

Pass `BleOpenOptions.scheduler` for a platform-safe clock. The default uses ordinary JavaScript timers; Boardsesh's mobile WLED adapter injects its background-safe scheduler. The existing native iOS adapter submits complete messages to Swift and is intentionally **not** a raw `BleTransport`: wrapping it here would chunk and queue twice.

## Repository integration

`@boardsesh/ble-protocol` retains Boardsesh frame-string compatibility APIs. It resolves catalog placements and colors before calling these packages. Platform policy, app identity, analytics, privacy, and UI stay with the application. Protocol specifications live in each family's `docs/`; application QA stays in the repository's central documentation.
