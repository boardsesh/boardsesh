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

`diodeIds` are physical diode addresses for the controller's model; resolve catalog holds before calling this package. `expectedModelId` is required: pass the model of the board setup the climber selected. `open()` refuses a controller whose FFF5 metadata is missing or reports another model, before any roster command, so diode addresses for one model never reach another. A layer operation resolves only after a fresh roster read shows the expected result for the caller's layer and every other player's layer; write success alone is never treated as proof. `expectedPlayers` refuses the mutation if the wall changed since the caller last looked. Requests are copied when submitted and run one at a time.

`rosterState` holds the last roster a transaction confirmed. FFF1 roster and wall-cleared broadcasts caused by other phones do not update it; subscribe with `onBroadcast()` to mirror them.

## Cancelling a layer call

Aborting the `AbortSignal` passed to `refreshRoster()`, `activateLayer()` or `removeLayer()` rejects that call with `BleError('cancelled')` straight away. What it means for the wall:

- A mutation the call had not written yet is never written.
- A mutation it had already written may have changed the wall. The session still reads the roster back, so `rosterState` shows what the wall holds. A replacement cancelled after its release (`0x43`) leaves the climber with no layer: the old one is gone and the new one was not lit.
- Call `refreshRoster()` to learn the outcome. It queues behind the read-back, and every later call also starts from its own fresh roster.

Aborting the signal passed to `open()` closes the connection and rejects with `BleError('cancelled')`.

## Transport requirements

- One `write()` is one complete GATT write. Quantum frames are never split; an activation of 92 diodes is 227 bytes. `open()` refuses `maxWriteBytes` below 45 (one single-diode activation, `QUANTUM_MIN_WRITE_BYTES`); above that, an activation that does not fit is refused as `frame-too-large` before anything is sent. Report the payload sizes the app adapters use: Android 182 or more after requesting MTU 512, 247 and 185 in turn; iOS `QB_` 512 (acknowledged long writes); otherwise the negotiated MTU minus 3; Web Bluetooth 509.
- `QB_` controllers are written with response and `QBB_` controllers without response. `open()` refuses an FFF2 characteristic that lacks the required mode.
- FFF4 and FFF5 need `read()`. FFF1 needs `subscribe()`, resolving only once notifications are enabled. Each notification value must be one complete controller frame. Call `onError` only when notifications are actually lost: it closes the session.
- Report a missing service or characteristic as `BleError('service-missing')`, so the session can try the legacy FFE0 service. Other lookup errors close the connection.
- When the session's signal aborts, cancel the platform operation it was passed to.
- Scanning, the device chooser, MTU negotiation, connect deadlines and ownership of the physical device across connection attempts stay with the connector.

Each FFF2 write, FFF4 read and FFF5 read has a 5 s deadline. A write or read that times out, or a roster notification that does not arrive within 3 s, closes the connection, because nothing proves the platform cancelled the operation. Only the commands layer transactions use (`0x41`, `0x43`, `0x44`, `0x47`) reach FFF2; turn-off-all and the other wall-wide commands are refused. Supply `BleOpenOptions.scheduler` for background-safe timers: the 50 ms and 250 ms transaction delays and every deadline run on it. Pass `time` only to replace the roster clock.

A caller's `isEligible` and `assertTargetAvailable` checks run inside the queue with no deadline, as in the app adapters; one that never settles holds later calls until `disconnect()`.

## Differences from the Boardsesh app adapters

Compared with `quantum-adapter.ts` (iOS and Android), `quantum-adapter.web.ts` and `QuantumBoardController` in `packages/mobile`:

| Behaviour | This package | App adapters today |
| --- | --- | --- |
| FFF1 notification error | Closes the session | Native ignores monitor errors |
| Roster notification wait expires (3 s) | Closes the link | Native closes it; web does not |
| Deadlines | 5 s per write, read and setup step | Native: the same 5 s; web: none |
| FFF4 read times out | Always closes the link | Native stops using FFF4 for that link when it could cancel the read, and closes only when it could not |
| FFE0 fallback | Only after `service-missing` | After any FFF0 error |
| Write size | Refuses `maxWriteBytes` below 45 | No floor; Android gives up only when even an MTU 185 request fails |
| `rosterState` | Confirmed transaction rosters only | `QuantumBoardController` also folds FFF1 rosters and wall-cleared broadcasts into its roster |
| Caller cancellation | `AbortSignal`, as above | None; `isEligible` turns false only while the link is abandoned |
| Commands written | `0x41`, `0x43`, `0x44`, `0x47` only | Any frame passed in |
| Link failures | `BleError` (`disconnected`, `timeout`, `cancelled`) | Plain `Error`, or the machine's `transport-failed` |
| Transaction delays | The injected scheduler | Global `setTimeout` |

Both require the model check; the released-model policy stays in the app.

Pure codecs (`encodeQuantumActivation()`, `parseQuantumBroadcast()`, `parseQuantumControllerMetadata()` and the rest) and `QuantumRosterTransactionMachine` remain available for integrations that already own BLE delivery.

See the [protocol specification](./docs/QUANTUM_BLUETOOTH_PROTOCOL_SPEC.md) for frame layouts, the transaction rules and verification limits. Quantum Board is a trademark of its owner; this is an independent compatibility implementation, not manufacturer-endorsed software.

Licensed under [Apache-2.0](LICENSE). Publishing and release automation are managed separately from this source package.
