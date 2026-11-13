# WLED BLE JSON protocol 1

This transport carries WLED runtime lighting state. It neither uses nor emulates
Aurora, MoonBoard, PPP, SLIP or the older Ble2Json protocol.

| GATT attribute | UUID | Properties |
| --- | --- | --- |
| Service | `2f8d0001-6f6e-4c9d-9b74-8a3d41c3a201` | Primary |
| Capabilities | `2f8d0002-6f6e-4c9d-9b74-8a3d41c3a201` | Read (supports long reads) |
| Request | `2f8d0003-6f6e-4c9d-9b74-8a3d41c3a201` | Write with response |
| Response | `2f8d0004-6f6e-4c9d-9b74-8a3d41c3a201` | Indicate |

Capabilities are unframed UTF-8 JSON containing `controllerId` (`wled-` followed
by 12 lowercase hexadecimal digits from the device MAC), `protocolVersion: 1`,
`name`, `wledVersion`, `ledCount`, `audio` and `maxMessageBytes` (8192).
`usermodVersion` and `buildId` identify installed firmware when present.
Read capabilities after connecting and compare the stable controller identity
before sending requests. Platform BLE peripheral IDs belong only in local caches.

Requests and responses use a four-byte unsigned little-endian UTF-8 byte length,
then precisely that many UTF-8 bytes. Length excludes the four-byte prefix, must
be positive, and cannot exceed 8192. Fragment the complete frame into ATT payloads
(MTU minus three bytes), including default 20-byte payloads. Chunk sizes never
mark completion. One frame per message; trailing bytes are errors. A message is
discarded after five seconds without fragments or whenever its connection ends.
Subscribe to indications before writing a request. Never automatically retry a
write after losing its acknowledgment.

Requests contain an ASCII string `id` matching `[A-Za-z0-9._:-]{1,64}` and `op`:

```json
{"id":"1","op":"getInfo"}
{"id":"2","op":"getState"}
{"id":"3","op":"setState","state":{"on":false,"tt":0}}
```

Only `setState` includes `state`. Unknown envelope fields or operations fail.
Success returns `{"id":"3","result":{"success":true}}`. Failure returns
`{"id":"3","error":{"code":"disallowed-state"}}` with an optional safe
`message`. An invalid or unreadable request ID is reported as the empty string;
clients terminate that exchange instead of treating it as a matching response.
Exactly one of `result` and `error` is present. `getInfo` results use
the WLED shape `{name,ver,leds:{count}}`; sanitized extra public fields may be
present. `getState` returns only runtime lighting state, including segment IDs.
Never expose network credentials, configuration or filesystem data.

The runtime state allowlist is strict and recursively validated before applying:

| Field | Allowed value |
| --- | --- |
| `on` | Boolean |
| `bri` | Integer 0–255 |
| `tt`, `transition` | Integer 0–65535 |
| `live` | `false` only (exit realtime mode) |
| `lor` | `1` only (runtime override) |
| `nl` | Object containing only `on` boolean |
| `udpn` | Object containing only `nn: true` (suppress broadcast) |
| `seg` | Nonempty array of up to 256 segment objects |

Segment fields: required integer `id` 0–255; optional `start` 0–LED count minus
one, `stop` 1–LED count (exclusive end), `on`/`rev`/`mi`/`frz` booleans,
`bri`/`fx`/`pal` integers 0–255, `grp` 1–65535, `spc`/`of` 0–65535,
`col` array of one to three RGB or RGBW byte arrays, and `i` individual colors.
When both bounds exist, start must precede stop.
`i` is a flat sequence of `[index, hexColor]` or `[start, stop, hexColor]`
groups. Indices must be within configured LED count. Range end is exclusive,
strictly greater than start, and at most the LED count. Colors contain exactly
six or eight hexadecimal digits. Unknown segment keys are rejected. Segment IDs must already exist in WLED;
missing IDs fail with `invalid-segment` before any state is applied.

One connected client and one outstanding request are allowed. BLE callbacks
assemble bounded messages; WLED's main loop validates and applies complete
messages using WLED's JSON lock. Disconnect discards incomplete and queued work.
Idle connections close after 15 seconds. Firmware update suspends BLE and clears
pending work. Clients serialize whole lighting operations, connect only while
needed and release the connection within two seconds after completion.

Acknowledgment means WLED accepted and applied the request. It does not establish
physical LED output. Wi-Fi and BLE share live state; the last completed command
wins. WLED current limiting continues to govern output power. No configuration,
credentials, reboot, OTA, presets or arbitrary usermod operations are exposed.

`test-vectors.json` contains canonical message/frame pairs for both C++ and
TypeScript host tests. JSON whitespace is insignificant; frame lengths always
describe the exact transmitted representation.
