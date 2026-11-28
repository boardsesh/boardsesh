# @boardsesh/aurora-ble-protocol

Aurora v2/v3 LED encoding and BLE sessions for compatible climbing-board controllers. Pure TypeScript; no React, native BLE library, catalog database, or browser globals. Kilter, Tension, Decoy, Touchstone, Grasshopper, and So iLL controllers use this wire format. The Kilter package supplies its two-LED power profile.

```ts
import { connectBoard } from '@boardsesh/ble-core';
import { createAuroraProtocol } from '@boardsesh/aurora-ble-protocol';

// connector implements the raw GATT contract in @boardsesh/ble-core.
const protocol = createAuroraProtocol({
  rolePalette: { start: [0, 255, 0], hand: [0, 0, 255], finish: [255, 0, 0] },
});
const session = await connectBoard(protocol, connector, selectedDeviceId);
await session.show([{ index: 42, role: 'start' }, { index: 256, color: [255, 0, 0] }]);
await session.clear();
await session.disconnect();
```

`index` is the physical LED address. Resolve catalog placements before calling this package. RGB entries need no palette; role entries require explicit wire colors. `show([])`, unsupported roles, invalid addresses/colors, and a v2 result whose LEDs all scale to darkness are rejected before writes. Use `clear()` deliberately.

`encodeAuroraLights()` accepts the same physical inputs without connecting and returns bytes plus power diagnostics. `encodeAuroraClear()` produces an explicit clear command. The lower-level `encodeAuroraEntries()` accepts physical addresses and six-digit RGB hex, retaining v2 overflow skipping for compatibility; it returns no bytes for empty input. Codecs default to API 3. Connected sessions infer API level from the advertised name and default to API 2 when it is absent; callers can override `apiLevel` explicitly.

Sessions serialize complete messages and copy inputs before queueing. A failed write closes the session; no reconnect or ambiguous retry is attempted. Standard Aurora profiles start with unacknowledged writes, at most 244 bytes and 5 ms between chunks. Only an explicit `NotSupportedError` enables a 20-byte acknowledged retry. Bare Aurora names without a serial use the Kilter-built controller profile: acknowledged 20-byte writes, 100 ms apart. `writeProfile` can select either profile explicitly. The transport owns MTU negotiation; this package never requests one.

Implement a connector using [the BLE core transport contract](../ble-core/README.md). `write()` must mean one raw ATT payload. A native subsystem that already chunks whole messages must use the codec API instead. Boardsesh retains its existing platform-specific transport policies through compatibility adapters.

The [protocol specification](./docs/AURORA_BLUETOOTH_PROTOCOL_SPEC.md) preserves source evidence and hardware limitations. Compatible-client support does not imply affiliation with or endorsement by any board manufacturer. Apache-2.0; registry publication and compiled distribution artifacts are outside this extraction.
