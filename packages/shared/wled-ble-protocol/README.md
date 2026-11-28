# WLED BLE protocol

Portable TypeScript codecs and connection sessions for the Boardsesh WLED BLE
usermod. This is a custom WLED usermod protocol, not built-in Bluetooth support
in every WLED installation. See [the protocol specification](./docs/protocol.md)
and [interoperability vectors](test-vectors.json).

The package uses `@boardsesh/ble-core` and has no React, Expo, DOM Bluetooth,
database, or native Bluetooth SDK dependency. Package publication is not enabled
by this extraction.

## Connect and light a wall

Supply a `BleConnector` from `@boardsesh/ble-core` for your Bluetooth stack. It
opens an already-selected device; permissions, scanning, device selection and
native connection deadlines belong to your application.

```ts
import { connectBoard, type BleConnector } from '@boardsesh/ble-core';
import { createWledBleProtocol } from '@boardsesh/wled-ble-protocol';

async function lightWall(connector: BleConnector, deviceId: string) {
  const protocol = createWledBleProtocol({
    expectedControllerId: 'wled-aabbccddeeff',
    brightness: 64,
    rolePalette: { start: [0, 255, 0], hand: [0, 0, 255], finish: [255, 0, 0] },
  });
  const session = await connectBoard(protocol, connector, deviceId);
  try {
    await session.show([{ index: 0, role: 'start' }, { index: 12, color: [255, 0, 0] }]);
    const state = await session.request('getState');
    await session.clear();
    return state;
  } finally {
    await session.disconnect();
  }
}
```

`deviceId` is the platform's peripheral identifier. `expectedControllerId` is the
stable firmware identity read from the capabilities characteristic; supplying it
prevents a remembered peripheral ID from silently selecting another controller.
`session.capabilities` describes the common lighting API, while
`session.controllerCapabilities` contains the firmware version, LED count,
message limit and stable identity.
Options and palette colors are copied when creating the protocol or opening a
session directly. The common capabilities list only roles present in that palette.

## Session contract

- `show` accepts physical zero-based LED indices, explicit RGB, or roles with an
  explicit palette. Empty, out-of-range, or unsupported inputs are rejected before
  writing. `clear` turns lighting off without saving configuration or presets.
- One session serializes whole `show`, `clear`, and raw request operations.
  Inputs are copied when submitted. Each `show` reads the current segment layout
  and resets the full strip before lighting its pixels, including on a persistent
  connection shared with another WLED client.
- The transport must implement capability reads, acknowledged writes, and
  response indications. Subscribing must finish before requests start. Writes
  are individual ATT chunks, never already-chunked native messages.
- Request timeout is 12 seconds, each write/setup operation is bounded to
  10 seconds, and an incomplete response expires after 5 seconds. Active request
  cancellation or transport/protocol failure closes the session. Failed commands
  are never replayed. Inject a scheduler when ordinary JS timers cannot run in
  your platform's background mode.
- `readWledBleCapabilities` probes without lighting writes. Native integrations
  that already performed that probe can use `openWledBleSession` with the same
  connected transport. Failed initialization and explicit disconnect release
  notifications and the transport; disconnect waits for radio cleanup.

## Lighting engine and compatibility

`@boardsesh/wled-ble-protocol/lighting` contains the transport-independent lighting
command engine, pixel validation, options, and error types. Both existing
Boardsesh HTTP and BLE LED-controller drivers delegate to it. HTTP retains
nightlight auto-off; the BLE usermod accepts `nl.on` only, so BLE sessions disable
that duration-based feature. Low-level frame/UTF-8 codecs and validators retain
their original exports.

## Boardsesh native adapter evidence limits

The current `react-native-ble-plx` bridge returns a subscription cancellation
handle immediately. Its installed JavaScript implementation reports notifications
and failures but exposes no successful CCCD-ready callback; Android starts
notification setup asynchronously through RxAndroidBle. The app preserves that
existing native operation ordering rather than introducing a delay. Unit tests
prove listener installation precedes request submission, but do not prove
notification readiness on physical hardware. First-response delivery still needs
real-device validation on iOS and Android. External transports must satisfy the
portable interface's stronger readiness contract.

Mobile disconnect keeps its 1.8-second caller deadline. If native connection,
write, discovery, or cancellation work is still pending after a caller deadline,
the adapter rejects new WLED operations until that actual work settles. This
prevents a late cancellation from disconnecting a newer session; a caller timeout
alone is never proof that native radio ownership ended.
