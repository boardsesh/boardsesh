# @boardsesh/kilter-ble-protocol

A Kilter profile over the shared Aurora wire protocol. It uses the same encoder and sets two physical LEDs per addressed hold for API v2 power scaling. No copy of Aurora's encoder or application catalog is included.

```ts
import { connectBoard } from '@boardsesh/ble-core';
import { createKilterProtocol } from '@boardsesh/kilter-ble-protocol';

const protocol = createKilterProtocol();
const session = await connectBoard(protocol, connector, selectedDeviceId);
await session.show([{ index: 42, color: [0, 255, 255] }]);
await session.clear();
await session.disconnect();
```

The caller resolves physical LED addresses and provides RGB colors, or supplies `rolePalette` explicitly for semantic roles. `encodeKilterLights()` provides the same encoding without a connection; `encodeKilterClear()` produces an explicit clear. API-level inference, queues, cancellation, and write profiles are described in [the Aurora package](../aurora-ble-protocol/README.md). Serial-bearing boxes retain the standard Aurora profile. Bare-name boxes use acknowledged 20-byte writes, 100 ms apart; this does not rewrite existing Boardsesh platform transport policy.

`isKilterDeviceName()`, `parseApiLevel()`, and `parseSerialNumber()` help interpret advertisements. Discovery and permissions belong to the caller; selected device IDs are platform identifiers, not board catalog IDs.

The [Kilter LED Box connection specification](./docs/LED_BOX_BLE_CONNECTION_PROTOCOL.md) records the evidence from the Kilter Grips implementation, including its compatibility with Aurora. Kilter is a trademark of its owner; this compatible-client package is not affiliated with or endorsed by the manufacturer. Apache-2.0; no registry publishing is configured here.
