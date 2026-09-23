# Digital Training Boards (DTB) — integration spec

Status: research draft (2026-09-23). No product code yet.

Scope: this came from static reading of the public Android app (strings, .NET metadata and a blutter decompile of the Dart snapshot; no app code was run and no traffic was sent to DTB's servers), for interoperability: so Boardsesh can light holds on DTB walls that climbers already use. It records only what that needs, and leaves out every credential found in the app. Anything we build past Phase 1 waits for DTB's agreement (§7).

This covers what DTB is, what its app sends to a wall, how that compares with the boards we already support, and a phased plan for adding it. Claims taken from the app binaries are marked **[binary]**. Claims taken from DTB's website are marked **[site]**. Anything guessed is marked **[inferred]** or **[unverified]**.

## 1. What DTB is

- Digital Training Boards is a UK company (digitaltrainingboards.com) that started in 2017. It sells an LED retrofit for existing walls: woodies, spray walls, circuit boards, auto-belay walls. **[site]**
- The LEDs sit behind acrylic lenses in 12 mm holes drilled into the wall. A kit covers 50 to 1,000 LEDs; 400 to 500 is typical. A control box drives the LED chain. **[site]**
- DTB says it has installed 200+ systems as of September 2026. **[site]** The app ships a wall list of 108 walls: 84 in England, 5 in Wales, 5 in Germany, 4 in Scotland, and the rest in France, Norway, the Isle of Man, Spain, Canada and Australia. **[binary]**
- DTB sells no fixed board. Each wall has its own grid, hold map and photo. That makes DTB much closer to our **spray walls** than to Kilter or MoonBoard.
- There is one Android app, **DTB**, package `com.companyname.desktopmobileclient`. On iOS the app is called **dtb2** (App Store id 6754847862).
- Climbs are user-generated and stored in DTB's cloud, behind one DTB account that works on every wall. **[site]**

### App versions

APKs were fetched from APKPure. SHA-256 hashes are in the appendix.

| Version | Date | Stack | Bluetooth permission |
| --- | --- | --- | --- |
| 1.0 | Aug 2025 | .NET MAUI Blazor Hybrid (AOT, Syncfusion UI) | no |
| 1.0.0 | Dec 2025 | Flutter (Dart package `dtb2`) | no |
| 2.0.0 | Jul 2026 (current) | Flutter (`dtb2`) | **yes**: `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` |

DTB's website still says the app "uses internet connection rather than bluetooth". That was true until 2.0.0, which added direct Bluetooth casting alongside the cloud path. **[binary]**

## 2. How the app lights a wall

There are two routes to the LEDs. The app chooses between them with a `bluetoothMode` setting and a "Bluetooth nearby" state. **[binary]**

### 2a. Cloud cast (every version)

```
phone ──HTTPS/WebSocket──▶ Azure SignalR hub "updater" ──▶ wall controller (always online)
```

- The hub is at `https://problemswebapi20220905155830.azurewebsites.net/updater`. It is ASP.NET Core SignalR with the negotiate step (`/updater/negotiate?negotiateVersion=0`). **[binary]** Version 0 negotiation has no connection token; a Boardsesh client should try `negotiateVersion=1` first.
  - Version 1 used the .NET SignalR client.
  - Version 2 implements the SignalR JSON protocol by hand over `web_socket_channel`. The binary contains the WebSocket accept GUID `258EAFA5-…`.
- Hub methods named in version 1 (`ClientServices.dll`), all **[binary]**:
  - Client to server: `JoinBoard` (log line: "`<user>` joining `<wall>`") and `UpdateProblem` (problem plus `mirrored` flag).
  - Server to client: `BoardJoined` ("Board joined successfully current problem: …") and `ProblemUpdated`.
- Version 2 connects to `wss://…/updater?id=<connectionId>`, sends the SignalR JSON handshake, then sends SignalR invocations `{"type":1,"target":"UpdateProblem","arguments":[…]}` (`websocket_service.dart`). **[binary]** The argument contents are **[unverified]**; the Bluetooth messages in §2c are the likely payload.
- **Geofence.** Every wall row carries a latitude, a longitude and an activation distance in metres (`ActivationDistanceMeters`). The distance is 500 m for most walls; one test wall uses 100,000 km, which switches the check off. The app checks the phone's GPS position against this before it will cast (`CalculateDistanceFrom`, `geolocator`). **[binary]** Whether the server enforces the geofence as well is **[unverified]**. The answer decides whether a Boardsesh backend could relay casts without a phone at the wall.
- Walls can have a passcode (`WallPasscode`, `GetPasscodeForWall`, `passcode/` endpoint). **[binary]**

### 2b. Bluetooth cast (2.0.0 only)

Everything in this section comes from the 2.0.0 binary (`package:dtb2/services/ble_cast_service.dart`, class `BleCastService`, using `flutter_blue_plus`):

| Item | Value |
| --- | --- |
| GATT service | `12345678-1234-5678-1234-56789abcdef0` |
| Cast characteristic | `12345678-1234-5678-1234-56789abcdef1` |
| CCCD | `00002902-…` (notifications on the characteristic) |
| Advertised / display name | "DTB Board" (probably the name filter; **[inferred]**) |
| Write options | `write_type` and `allow_long_write` are both present, so there are long writes / MTU handling |
| Error when the characteristic is missing | "DTB cast characteristic not found." |

The UUIDs are the placeholder values from the standard ESP-IDF / BlueZ GATT-server examples. The controller is very likely an ESP32 with a custom GATT server. **[inferred]**

Connection policy is a user setting **[binary]**:

- "Disconnect 5 seconds after each cast so other users can connect." A controller accepts one central at a time, and DTB treats that as shared-wall etiquette.
- "Disconnect 30 seconds after the last cast."
- "Auto Cast to Board" sends the problem while you swipe through problem details.

### 2c. The Bluetooth message (decompiled)

Everything below comes from a blutter decompile of 2.0.0 `libapp.so` (Dart 3.12.2, snapshot `ace654289f5abc240509fc941453ebc5`). **[binary]** Function names are cited so each claim can be checked.

**Framing.** There is none. `BleCastService.sendMessage(map, deviceName)` calls `jsonEncode(map)`, UTF-8 encodes the result and makes one `BluetoothCharacteristic.write(bytes)` call with flutter_blue_plus defaults: write-with-response, no long write. On Android, flutter_blue_plus requests an MTU of 512 on connect, so a whole message fits in one ATT write. There is no header, no checksum and no chunking. A static flag drops a second write while one is still in flight ("BLE write already running, ignoring duplicate").

**Finding the board.** The app scans and picks the device whose `platformName.trim()` equals `"DTB Board " + wallId` (`_getCastCharacteristic`, the scan-result closure). It then looks up the service `…def0` and characteristic `…def1`. Every wall has its own name, so the phone connects to the right wall even when two DTB walls are within range.

**Messages.** The `castMethod` preference picks `"bluetooth"` or `"websocket"`. The maps below are the Bluetooth payloads; the WebSocket path sends `UpdateProblem` instead (§2a).

| `type` | Sent from | Fields |
| --- | --- | --- |
| `cast_problem` | `_ProblemDetailPageState._sendToBoard` | `user`, `problem`, `wallId`, `mirrored` |
| `preview_problem` | `_CreateProblemPageState._sendPreviewToWall`, hold filter page | `wallId`, `problem`, `holds`, `mirrored` |
| `test` | settings page | `problem: "test"` (device name is plain `"DTB Board"`) |

```json
{"type":"cast_problem","user":"eli","problem":"roll up 6b+","wallId":"<wall key>","mirrored":false}
{"type":"preview_problem","wallId":"<wall key>","problem":"New problem being created by …","holds":["K2","N15","Q8"],"mirrored":false}
```

What the fields mean:

- `problem` in `cast_problem` is the problem's **name**, not its holds. The message carries no LED data. The controller must already hold that wall's problem list and look the name up itself. This is the most important constraint for Boardsesh: we cannot cast a Boardsesh-created climb with `cast_problem`.
- `holds` in `preview_problem` is a list of grid labels. `HoldUtils.labelForWs(n, columns)` turns hold number `n` into a label: `i = n - 1`, column letter = `chr(65 + i % columns)`, row = `i ~/ columns + 1`. So on a 21-column wall `hold1` → `A1`, `hold2` → `B1` and `hold22` → `A2`, which matches `holdlist.csv`. The message has no roles, so a preview cannot say which holds are start or finish. This is the only message Boardsesh can use for arbitrary climbs.
- `user` is the logged-in username, or `"guest"`.
- `mirrored` is a bool. It is always `false` for previews.
- `wallId` is the value read from the wall object's first field. It is probably the folder key, such as `ManDepot50` **[inferred]**; confirm on a real wall.

**After a write** (`_handleDisconnectMode`, the `bluetoothMode` preference):

| Mode | Behaviour |
| --- | --- |
| `exclusive` | Keeps the connection open. |
| `shared` | Disconnects 5 s after each cast. |
| `auto` | Disconnects 30 s after the last cast. |

Compared with our existing boards, DTB is simpler than Aurora (no RGB, no framing) and closer to Woods, since the controller picks the colours. The difference is that DTB speaks JSON with grid labels, where Woods sends `index,role,…!`.

## 3. Data model

### Wall list

`walllist.csv` is bundled with the app and also fetched from `/walls/global/walllist.csv`. Columns **[binary]**:

```
id, country, gym name, angle label, latitude, longitude, folder key, activation distance (m), status
2,England,Depot Manchester ,50°,53.46462667,-2.320755302,ManDepot50,500,1
```

### Per-wall folder

Folders are keyed like `ManDepot50`. Version 2 downloads them from DTB's Dropbox (`dropbox_file_service.dart`); version 1 bundled them. Each folder holds **[binary]**:

| File | Contents |
| --- | --- |
| `wall.png` | Photo of the wall. |
| `holdlist.csv` | One grid label per line; the line index is the hold/LED number. `hold1` → `A1`, `hold2` → `B1`, … The default wall has 441 holds. |
| `dicholdlist.txt` | JSON map from grid label to pixel position on `wall.png`, e.g. `"K2": [613, 707]`. `[-30, -30]` means there is no hold at that grid cell. |
| `MirrorDic.txt` | JSON map from grid label to its mirrored label, e.g. `"B1": "T1"`. Used for symmetric walls. |
| `Settings` | Line-based config; format below. |
| `test.csv` | That wall's problem list, used for offline and legacy access. |

`Settings` format, with line meanings taken from the bundled file:

1. columns
2. rows
3. symmetric wall (0/1)
4. unused
5. unused
6. touchscreen
7. feet-specific wall
8. foot options, e.g. `hold1,Blue Feet,hold43,Black Feet`. Each foot option has its own LED that lights a feet-rule indicator.
9. unused
10. unused
11. unused
12. auto-belay (at least 28 rows)
13. minimum grade
14. pre-drill offset
15. home wall
16. language
17. superuser list
18. circuit board
19. maximum holds selectable without logging in

Lines 4–5 are button height and width on the creation page, line 9 is display text the app ignores, and lines 10–11 repeat lines 8–9.

### Problem

`test.csv` and the API share the same row shape **[binary]**:

```
name, grade, comment, setter, stars, hold…
Wonder Woman 6a,6a,No Comment,James Ox,1,hold175,hold66,hold193,hold364,hold1,hold431
```

Hold roles are positional **[inferred from rows]**:

- The first two holds are the start holds. They are repeated when there is a single start (`hold91,hold91`).
- The last hold is the finish.
- Holds that match a foot option (`hold1`, `hold43`) are feet-rule markers, not holds you climb on.
- Everything else is a hand hold.

Grades are Font strings (`6a`, `6b+`), and there is a `frenchToVGrade` conversion. Problems also carry `Mirrored`, `Stars`, `Setter`, `Comment`, `Project`, `Circuit`, `FootType`, `Favourite` and `suggested_grade`.

### Cloud REST API

Two Azure Functions apps back the v2 app: `dtb2-func-…ukwest-01.azurewebsites.net/api` and `dtb2-func-v2-…/api`. Routes seen in the binary **[binary]**:

- `/users/login`, `/users/register`, `/users/reset`, `/users/update`, `/users/delete`
- `/problems`, `/problems/{id}`, `/sent/`
- `/sessions`, `/sessions/attempt`, `/sessions/tick`, `/ticks`
- `/lists`, `/likes`, `/comments?problem=`
- `/whatson`, `/wall-log`, `/test?user=`

Auth uses `access_token` / `refresh_token`, with a bearer header in v1 and an `is_superuser` flag. Request and response bodies are **[unverified]**.

The binaries embed third-party credentials: a Dropbox app key and refresh flow, and Syncfusion licence keys. They are deliberately left out of this document, and Boardsesh must not use them.

## 4. How this maps onto what we already do

| Concern | Existing pattern | Fit for DTB |
| --- | --- | --- |
| BLE encoder | `ble-protocol/src/{aurora,moonboard,woods}.ts`, mirrored in Swift `BoardBleEncoding.swift` | New `dtb.ts` encoder: JSON `preview_problem` with grid labels (§2c). Simpler than Woods; there are no roles. |
| BLE transport | UART family (`6e400001`) or Aurora family, see `transport.ts`, `BoardScanFamily` in `mobile/src/lib/ble/types.ts` | Neither fits: DTB uses its own service UUID. Either add a third `BoardScanFamily` (`types.ts` says to review adapter options before doing this) or a per-board service/characteristic override in `adapter.ts`. |
| Connection etiquette | Aurora keeps the connection; iOS has no auto-reconnect | DTB expects you to disconnect after a cast. Add an idle-disconnect option to `use-board-bluetooth.ts`. |
| Board identity | Fixed catalogue (`PRODUCT_SIZES`, `board_layouts`) | Poor fit: every DTB wall is unique. |
| Per-wall layouts | **Spray walls** (`docs/spray-walls.md`): runtime-created layouts under one `board_type`, holds as photo x/y | **Best fit.** One `board_type = 'dtb'`, one layout per DTB wall folder, holds from `holdlist.csv` + `dicholdlist.txt`, background from `wall.png`. |
| Climb catalogue | Woods/MoonBoard one-off import scripts (`packages/db/scripts/import-woods-catalog.ts`, `docs/moonboard-catalog-import.md`); Aurora sync daemons | DTB climbs grow every day (about 50 per wall in the first week, per the site), so a one-off import goes stale. The long-term path is a linked-account sync daemon mirroring the standalone `packages/aurora-sync` / `packages/kilter-sync` packages (a new `packages/dtb-sync`). |
| Capabilities | `CAPABILITIES_BY_BOARD` in `shared/board-config/src/board-capabilities.ts` | New `dtb` row using existing flags. Per-wall layouts come from the spray identity model (`isSizeScopedBoard`), so no new flag. A `cloudCast` flag waits for Phase 3. |
| Offline | Nightly per-(boardType, layout) SQLite snapshots | Works once `board_climbs` rows exist. Fine for about 108 walls. |

Woods (`git show --stat 50098833707716d8235b8f78624b3cb930ee0bda`, #3306) is the closest reference diff for adding a non-Aurora board type end to end.

## 5. Touch points for a `dtb` board type

1. `packages/shared-schema/src/types/board-config.ts`: add to `SUPPORTED_BOARDS` and `BOARD_DISPLAY_ORDER`. Do not add it to `AURORA_BOARDS`.
2. Every `Record<BoardName, …>` map; the compiler lists them.
   - board-constants: `product-sizes.ts`, `hold-states.ts` (`HOLD_STATE_MAP` roles plus a feet-marker role), `board-type-labels.ts`, `stable-json.ts`.
   - board-config: `board-capabilities.ts`, `board-data.ts`, `board-name.ts`.
3. `packages/shared/ble-protocol/src/dtb.ts`, `transport.ts` (UUIDs), `web-transport.ts`; mobile `lib/ble/` (scan filter, adapter, send branch, idle disconnect).
4. Swift `BoardBleEncoding.swift` / `BoardBleManager.swift`, or set `nativeBoardControl: false` at first so no native change is needed. Mandatory BLE review by Fable or Astra (CLAUDE.md).
5. DB import script in `packages/db/scripts` (Phase 2) or a `packages/dtb-sync` daemon (Phase 3), with layout rows per wall and wall photos stored the same way as spray photos.
6. i18n for board labels in all four locales.

## 6. Phased plan

**Phase 0: confirm on a wall.** The frame is decoded (§2c). Before writing code, check the open items in §8 on one real wall. Contact DTB in parallel (§7).

**Phase 1: Bluetooth casting of Boardsesh-created climbs on DTB walls.**
- A climber picks their DTB wall, draws a climb on the wall photo and casts it over Bluetooth as a `preview_problem`. Hold roles are not carried, so start and finish show only in the app.
- Needs the wall geometry: the per-wall folder files. **Gate:** we can't take these from DTB's Dropbox (see Risks), so Phase 1 starts only once DTB or a partner gym provides the files for at least one wall.
- No DTB account and no DTB climb data are involved.
- Risk 5/5 (BLE). Ships as a native change on `release/next` only if a new native module is needed; `react-native-ble-plx` can already talk to a custom GATT service, so this is probably JS-only.

**Phase 2: DTB catalogue.** Read DTB problems for a wall into `board_climbs`. This needs DTB's permission or a partner API; see §7.

**Phase 3: Linked-account logbook sync and cloud cast.** Sync ticks and sessions, and let a climber cast through the SignalR hub from anywhere inside the geofence. Needs server-side geofence behaviour confirmed and DTB's agreement.

Risks:
- **Terms and relationship.** DTB is a one-person-scale UK company. Its API is private and changed stacks twice in a year (.NET, then Flutter, then BLE added).
- **Shared walls.** The controller takes one connection at a time, so Boardsesh must honour disconnect-after-cast or it will lock gym users out of the wall.
- **Wall files.** Wall files are served from DTB's Dropbox via a key embedded in their app. We must not reuse that key; wall geometry has to come from DTB or from the gym.

## 7. Questions for DTB

1. Would they give Boardsesh a partner API, or a data export for problems, walls and hold maps?
2. Will they keep the JSON Bluetooth messages stable, and add hold roles to `preview_problem`?
3. Does the server enforce the geofence for cloud casts?
4. How many walls run BLE-capable controller firmware? Older boxes are probably cloud-only.
5. Is the controller ESP32-based, and does it accept more than one central at a time?

## 8. How the BLE frame was recovered, and what is still open

The frame in §2c came from blutter (github.com/worawit/blutter, commit `4a60ac6`) run on `lib/arm64-v8a/libapp.so`. blutter writes Dart-annotated arm64 assembly, one file per Dart source file. The most useful files are `asm/dtb2/services/ble_cast_service.dart`, `asm/dtb2/hold_utils.dart`, `asm/dtb2/create_problem_page.dart` and `asm/dtb2/features/problem_detail/presentation/problem_detail_page.dart`.

Still to confirm on a real wall, with an Android HCI snoop log while casting:

1. The `wallId` string format and the advertised name.
2. Whether a `preview_problem` lights every hold one colour, or colours the first and last holds as start and finish.
3. How the controller gets its problem list for `cast_problem`, and whether it keeps it in sync through the cloud.
4. Whether older controllers without BLE firmware exist in the field.

See also `docs/LED_BOX_BLE_CONNECTION_PROTOCOL.md` and `docs/WOODS_BLUETOOTH_PROTOCOL_SPEC.md`.

## Appendix: artefacts

The artefacts are stored locally at `~/.cache/dtb-re/`; they are not committed.

| File | SHA-256 |
| --- | --- |
| `DTB_v2.0.0` XAPK | `d26ccdd04449341bf781b36f3bf12f92175e45bac7c6521cde45ee60ffb709bd` |
| 2.0.0 base APK | `13a00d9be8eafe3c92cf82e9b4ce4ea32b4b60ddebe7fca03487893f7f1ebc63` |
| 2.0.0 `config.arm64_v8a` | `6d0aaa35a8cebf4eaf05aa6ff387f64d07a4cc374bfbe8d36bbfb24fe4184731` |

The 2.0.0 package is version code 30004, with minSdk 24 and targetSdk 36. The 1.0 and 1.0.0 XAPKs sit in the same folder.
