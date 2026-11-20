# Rogue Fitness Timer — Bluetooth LE Protocol Spec

Reverse-engineered from the Rogue Fitness Android app.

- **Package:** `com.roguefitness.app`
- **Version:** 4.5.0.117190 (APK pulled from APKPure, ~92 MB)
- **Stack:** React Native (Hermes bytecode bundle) + `react-native-ble-plx`
- **Method:** Hermes bundle (`assets/index.android.bundle`, HBC v96) disassembled/decompiled with `hermes-dec`; protocol read out of the decompiled `ConsoleMonitor` / `RogueProtocol` / timer-remote modules.

Everything below marked **Confirmed** was read directly out of the app's own code. Items marked **Inferred** are reasoned from surrounding code but not 100% pinned to a single call site.

---

## 1. Scope: which "timer"

The app drives two BLE device families. This spec is about the **timers**:

| Device                       | `type` | `isTimer` | Advertised service | GATT service                           |
| ---------------------------- | ------ | --------- | ------------------ | -------------------------------------- |
| **Rogue Home Timer 2.0**     | 2      | ✅        | `ffe0`             | `0000ffe0-0000-1000-8000-00805f9b34fb` |
| **Rogue Echo Gym Timer 2.0** | 3      | ✅        | `ffe0`             | `0000ffe0-0000-1000-8000-00805f9b34fb` |

The other family — **Rogue Console / Echo Bike V3 / Echo Ski / Rower** — is a different, much heavier protocol (FTMS advertising `1826`, GATT service `0000fff0-…-e50e24dcca9e`, packetised commands with ACKs). It is summarised in [Appendix A](#appendix-a-console-bikerowerski-protocol-summary) but is **not** the timer.

The `ffe0/ffe1/ffe2` service is a stock **HM-10-class transparent-UART BLE module**. The timer behaves like a screen you drive with a remote: the app sends **remote-control key codes**; there is no rich telemetry.

---

## 2. GATT profile (timer)

From the app's `DEVICES` table:

```
Service   0000ffe0-0000-1000-8000-00805f9b34fb   (advertised as 16-bit 0xFFE0)
 ├─ Char  0000ffe1-0000-1000-8000-00805f9b34fb   ("read"  in the table; NOTIFY + WRITE in practice)
 └─ Char  0000ffe2-0000-1000-8000-00805f9b34fb   ("write" in the table; not used by the timer command path)
Configured MTU: 131
versionArray:   [01, 01, 01, 01]
```

> **Quirk (Confirmed):** although the config labels `ffe1` = read and `ffe2` = write, the actual timer-command code writes to **`ffe1`**, and the notification subscription is also set up on the "read" characteristic. So `ffe1` is the single bidirectional UART pipe (classic HM-10). `ffe2` is effectively unused for timers.

---

## 3. Discovery / scan filter

**Confirmed.** A candidate is treated as a Rogue device when **both** are true:

- **Service match** — advertised `serviceUUIDs` contains (case-insensitive substring) `1826` **or** `ffe0`.
  Scan filter constant: `serviceUUIDs = ['FFE0', 'FFF0']`.
- **Name match** — `name` or `localName` (lowercased) contains `rogue` **or** `echo`.

Device type is classified from the name (`detectDeviceType`, substring, case-insensitive):

| Name contains                    | Type      |
| -------------------------------- | --------- |
| `timer`, `home tim`, `gym tim`   | **timer** |
| `console`, `rower`, `echo_rower` | rower     |
| `bike`, `echo_bike`              | bike      |
| `ski`, `echo_skier`              | skier     |
| _none of the above_              | unknown   |

(There is also `extractConsoleIdFromName` that pulls a 6-digit serial out of console names — not relevant to timers.)

---

## 4. Connection handshake

**Confirmed**, from `bleManager.connectToDevice` + `ConsoleMonitor.connect`/`setupNotifications`:

1. `connectToDevice(id)` wrapped in `Promise.race` with a **15 000 ms** connection timeout.
2. **Android only:** `device.requestMTU(517)` → `device.requestConnectionPriority(1)` (High) → `delay(200 ms)`.
   (iOS negotiates MTU itself; the 131 in the device table is the app's assumed usable size.)
3. Discover services; verify the device exposes `0000ffe0-…` (timer) or `0000fff0-…` (console).
4. `setupNotifications`: locate the notify characteristic (`ffe1` for the timer), assert `isNotifiable`, and subscribe with `characteristic.monitor(...)`.
   - Inbound notification `value` is **base64** (ble-plx convention) → `Buffer.from(value, 'base64')` → byte array → `RogueProtocol.handleNotification(bytes)`.
   - Monitor errors containing `Operation was cancelled` / `was disconnected` / `powered off` are treated as a normal disconnect and tear the session down.

---

## 5. Timer command frame ⭐ (the core of this spec)

**Confirmed** — from `sendTimerCommand(code)` (two identical real implementations in the bundle; a third is a `MockConsoleService` no-op used in dev):

```
Frame (exactly 4 bytes, NO checksum, NO length field):

  ┌──────┬──────┬──────┬───────────┐
  │ 0x55 │ 0xAA │ 0x01 │  <code>   │
  └──────┴──────┴──────┴───────────┘
   sync0  sync1  type   command code (uint8, one of §6)
```

Pseudocode straight from the decompiled function:

```js
function sendTimerCommand(code) {
  const bytes  = [0x55, 0xAA, 0x01, code];          // 4 bytes, no CRC
  const value  = Buffer.from(bytes).toString('base64');
  try {
    await device.writeCharacteristicWithoutResponseForService(
      '0000ffe0-0000-1000-8000-00805f9b34fb',        // service
      '0000ffe1-0000-1000-8000-00805f9b34fb',        // characteristic
      value);
  } catch {
    // fallback if the peripheral rejects write-without-response
    await device.writeCharacteristicWithResponseForService(
      '0000ffe0-0000-1000-8000-00805f9b34fb',
      '0000ffe1-0000-1000-8000-00805f9b34fb',
      value);
  }
}
```

- `0x55 0xAA` — fixed 2-byte sync/preamble.
- `0x01` — fixed message-type/command-class byte (constant in every observed call).
- `<code>` — a single byte identifying the remote button (table below).
- **Write type:** Write **Without** Response preferred; falls back to Write **With** Response.
- **One command per write.** No batching, no sequence number, no CRC.

### Raw examples

| Action       | Bytes on the wire | Hex           | Base64 written to `ffe1` |
| ------------ | ----------------- | ------------- | ------------------------ |
| Power ON/OFF | `85 170 1 0`      | `55 AA 01 00` | `VaoBAA==`               |
| OK / Select  | `85 170 1 12`     | `55 AA 01 0C` | `VaoBDA==`               |
| RESET        | `85 170 1 10`     | `55 AA 01 0A` | `VaoBCg==`               |
| EMOM         | `85 170 1 33`     | `55 AA 01 21` | `VaoBIQ==`               |

---

## 6. Command code table ⭐

**Confirmed** — the complete button map (`topButtons` / `centerLeftButtons` / `centerRightButtons` / `centerButtons` / `numpadButtons`). The numeric `code` is the 4th byte of the frame.

| Code (dec) | Code (hex) | ID          | Label / meaning                              |
| ---------: | ---------- | ----------- | -------------------------------------------- |
|          0 | 0x00       | POWER       | On/Off                                       |
|          1 | 0x01       | VOICE       | Voice                                        |
|          2 | 0x02       | INT         | Interval timer                               |
|          3 | 0x03       | UP-DOWN     | Toggle count direction (up/down)             |
|          4 | 0x04       | STOPWATCH   | Stopwatch mode                               |
|          5 | 0x05       | BTS         | "BTS" preset button                          |
|          6 | 0x06       | FGB         | Fight Gone Bad preset                        |
|          7 | 0x07       | TBT         | Tabata preset                                |
|          8 | 0x08       | CLOCK       | Clock mode                                   |
|          9 | 0x09       | HOURS       | Toggle 12/24-hour format                     |
|         10 | 0x0A       | RESET       | Reset (clears stopwatch to 0:00)             |
|         11 | 0x0B       | PLUS10      | +10 s warm-up toggle                         |
|         12 | 0x0C       | OK          | OK / Select                                  |
|         13 | 0x0D       | ARROW-UP    | D-pad Up                                     |
|         14 | 0x0E       | ARROW-DOWN  | D-pad Down                                   |
|         15 | 0x0F       | ARROW-RIGHT | D-pad Right                                  |
|         16 | 0x10       | ARROW-LEFT  | D-pad Left                                   |
|         17 | 0x11       | EXIT        | Exit / Back                                  |
|         18 | 0x12       | SET         | Open timer setup                             |
|         19 | 0x13       | BTN0        | Numpad 0                                     |
|         20 | 0x14       | BTN1        | Numpad 1                                     |
|         21 | 0x15       | BTN2        | Numpad 2                                     |
|         22 | 0x16       | BTN3        | Numpad 3                                     |
|         23 | 0x17       | BTN4        | Numpad 4                                     |
|         24 | 0x18       | BTN5        | Numpad 5                                     |
|         25 | 0x19       | BTN6        | Numpad 6                                     |
|         26 | 0x1A       | BTN7        | Numpad 7                                     |
|         27 | 0x1B       | BTN8        | Numpad 8                                     |
|         28 | 0x1C       | BTN9        | Numpad 9                                     |
|         29 | 0x1D       | VOLUME-UP   | Volume Up                                    |
|         30 | 0x1E       | VOLUME-DOWN | Volume Down                                  |
|         31 | 0x1F       | —           | _(reserved / unused — no button maps to it)_ |
|         32 | 0x20       | WARMUP      | Warm-Up countdown                            |
|         33 | 0x21       | EMOM        | EMOM preset                                  |

Higher-level flows compose these. E.g. entering a value on the setup screen sends `SET` (18), then numpad codes (19–28), then `OK` (12); the interval "guide" overlay auto-fires `EXIT` (17) after setup completes.

---

## 7. Notifications from the timer

**Partly inferred.** The app subscribes to `ffe1` notifications and pipes every payload through the shared `RogueProtocol.handleNotification`, the same parser the consoles use for realtime workout frames. For a timer, meaningful telemetry is minimal/absent — the timer is a display driven by key codes, not a sensor. Treat inbound notifications as best-effort status echoes rather than a documented telemetry stream. The notification pipeline exists mainly so the same `ConsoleMonitor` code can service both device families.

If you are re-implementing a controller, you can drive a timer **write-only** (fire-and-forget key codes); you do not need to parse notifications to operate it.

---

## 8. Minimal re-implementation recipe (timer)

1. **Scan** for peripherals advertising service `0xFFE0` whose name contains `Rogue`/`Echo` (e.g. "Rogue Home Timer", "Rogue Echo Gym Timer").
2. **Connect**; on Android request MTU 517 + high connection priority; discover services.
3. **Subscribe** to notify on char `0000ffe1-0000-1000-8000-00805f9b34fb` (optional — for status echoes).
4. **To press a button**, write the 4-byte frame `55 AA 01 <code>` (Write Without Response, fall back to With Response) to char `0000ffe1-0000-1000-8000-00805f9b34fb` on service `0000ffe0-…`. No checksum, no ACK, one frame per write.

---

## Appendix A: Console (Bike/Rower/Ski) protocol summary

Not the timer, included for orientation. **Confirmed** framing from `RogueProtocol.buildPacket` / `buildPackets` / `sendCommand`:

- **Service** `0000fff0-…-e50e24dcca9e`, **write** char `fff2`, **notify** char `fff1`, MTU 247, advertised FTMS `1826`.
- **Single packet:** `[0x01, (lenHi?), lenLo, ...payload]` — leading `0x01`, then a 1- or 2-byte big-endian payload length, then payload.
- **Fragmentation** (payload+overhead > 248 bytes): sub-packets `[header, seq, chunkLenHi, chunkLenLo, ...chunk]` where `header` = **2** (first), **3** (middle), **4** (last); `seq` increments; chunk ≤ 244 bytes. Each sub-packet is ACK-gated (`awaitSubPacketAck`, 1000 ms timeout).
- Payload is base64-encoded for the ble-plx write, same as the timer.
- **Enums** used to build console payloads:
  - `WorkoutType`: JUST_ROW 0, FIXED_DISTANCE 1, FIXED_TIME 2, FIXED_CALORIES 3, INTERVAL_DISTANCE 4, INTERVAL_TIME 5, INTERVAL_CALORIES 6, MIXED 7.
  - `ConsoleWorkoutState`: FINISH 0, ROWING 1, REST 2.
  - `KeyEvent`: KEY_SELECT 0, KEY_UP 1, KEY_DOWN 2, KEY_COMP 3, KEY_UNIT 4, KEY_HOME 5, KEY_DISPLAY 6, KEY_RESET 7.
  - `EventType`: CLICK 0, LONGCLICK 1, LONGLONGCLICK 2.
  - `ConsoleHeartRateStatus`: NONE 0, FROM_HRM 1, FROM_APP 2.
- Supports record download opcodes `0x16` / `0x20`, workout config get/set, `syncUTCTime`, `sendHeartRate`, display-unit set, and BLE firmware update (`writeFirmware`, `setFastSpeedMode`).
- Timing constants: record-response timeout 5000 ms, retry gap 300 ms, inter-command gap 200 ms.

---

## Appendix B: How this was extracted (repro)

```bash
# 1. Pull the APK
curl -L -A '<browser UA>' -o rogue.apk \
  'https://d.apkpure.com/b/APK/com.roguefitness.app?version=latest'

# 2. Extract the JS bundle (Hermes bytecode)
unzip -o rogue.apk assets/index.android.bundle -d extracted

# 3. Disassemble / decompile with hermes-dec (pip install hermes-dec)
hbc-disassembler extracted/assets/index.android.bundle disasm.hasm
hbc-decompiler  extracted/assets/index.android.bundle decomp.djs

# 4. Grep the decompiled output for:
#    - UUIDs:            0000ffe0/ffe1/ffe2, 0000fff0/fff1/fff2, 1826
#    - the timer frame:  [85, 170, 1]      (== 0x55 0xAA 0x01)
#    - functions:        sendTimerCommand, buildPacket(s), handleNotification,
#                        detectDeviceType, isRogueDevice, DEVICES table
#    - the code table:   topButtons/centerButtons/… with 'code' fields
```
