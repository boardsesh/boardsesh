# @boardsesh/quantum-ble-protocol

Encode Quantum Board controller commands, parse controller rosters, and run confirmed layer transactions over BLE. The package has no React, catalog, native SDK, or browser dependency. It uses the transport contracts from `@boardsesh/ble-core`.

## A shared wall, not a single route

A Quantum controller lights several coloured layers at once, one per player; this package accepts up to four (firmware capacity is unverified). Each layer has an owner (a user UUID), a route UUID, a colour and a set of diode addresses. The session therefore exposes layer operations instead of whole-wall lighting:

- `refreshRoster()` asks for the route list (`0x47`) and reads it back.
- `activateLayer()` adds or replaces the caller's own layer.
- `removeLayer()` removes the caller's own layer.

`show()` and `clear()` from `BoardBleSession` always reject `BleError('unsupported')` without a write, and `capabilities` reports `{ rgb: false, roles: [], readback: true }`. Generic code holding the session cannot overwrite another climber's layer or wipe the wall. No session method sends the turn-off-all command.

## Connect and light a layer

Supply a `BleConnector` implemented for your BLE library. It owns permissions, scanning, device selection, the platform connection deadline and, on Android, MTU negotiation. The returned transport's `deviceName` must be the advertised `QB_…` or `QBB_…` name.

```ts
import { connectBoard, type BleConnector } from '@boardsesh/ble-core';
import { createQuantumBleProtocol } from '@boardsesh/quantum-ble-protocol';

async function lightLayer(connector: BleConnector, selectedDeviceId: string, userId: string) {
  const wall = await connectBoard(createQuantumBleProtocol({ expectedModelId: 'xl' }), connector, selectedDeviceId);
  try {
    const before = await wall.refreshRoster();
    const after = await wall.activateLayer({
      routeId: '00112233-4455-6677-8899-aabbccddeeff',
      userId,
      diodeIds: [1, 258],
      color: 0x00ff00,
      expectedPlayers: before.players,
    });
    console.info(after.players);
    await wall.removeLayer({ userId, routeId: '00112233-4455-6677-8899-aabbccddeeff' });
  } finally {
    await wall.disconnect();
  }
}
```

`diodeIds` are physical diode addresses for the controller's model; resolve catalog holds before calling this package. Pass `expectedModelId` so a controller reporting another model is refused during `open()`, before any roster command. A layer operation resolves only after a fresh roster read shows the expected result for the caller's layer and every other player's layer; write success alone is never treated as proof. `expectedPlayers` refuses the mutation if the wall changed since the caller last looked. Requests are copied when submitted and run one at a time.

## Transport requirements

- One `write()` is one complete GATT write. Quantum frames are never split; an activation of 92 diodes is 227 bytes, so `maxWriteBytes` must allow it. A frame that does not fit is refused before anything is sent.
- `QB_` controllers are written with response and `QBB_` controllers without response. `open()` refuses an FFF2 characteristic that lacks the required mode.
- FFF4 and FFF5 need `read()`. FFF1 needs `subscribe()`, resolving only once notifications are enabled. Each notification value must be one complete controller frame.
- Report a missing service or characteristic as `BleError('service-missing')`, so the session can try the legacy FFE0 service. Other lookup errors close the connection.

Each FFF2 write, FFF4 read and FFF5 read has a 5 s deadline. A write or read that times out, or a roster notification that does not arrive within 3 s, closes the connection, because nothing proves the platform cancelled the operation. An `AbortSignal` rejects the caller's promise at once; the transaction stops at its next eligibility check and never sends another mutation. Supply `BleOpenOptions.scheduler` for background-safe timers and `time` for the roster clock.

Pure codecs (`encodeQuantumActivation()`, `parseQuantumBroadcast()`, `parseQuantumControllerMetadata()` and the rest) and `QuantumRosterTransactionMachine` remain available for integrations that already own BLE delivery.

See the [protocol specification](./docs/QUANTUM_BLUETOOTH_PROTOCOL_SPEC.md) for frame layouts, the transaction rules and verification limits. Quantum Board is a trademark of its owner; this is an independent compatibility implementation, not manufacturer-endorsed software.

Licensed under [Apache-2.0](LICENSE). Publishing and release automation are managed separately from this source package.
