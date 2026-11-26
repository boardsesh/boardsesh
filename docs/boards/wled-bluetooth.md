# WLED Bluetooth for Spraywalls

Boardsesh supports a separate WLED JSON-over-BLE controller type, `wled-ble`.
Firmware lives in the public [wled-usermod-ble-json repository](https://github.com/boardsesh/wled-usermod-ble-json).
It is an external WLED usermod, independent of Aurora and MoonBoard protocols.
The shared [protocol contract](../../packages/shared/wled-ble-protocol/protocol.md)
and [test vectors](../../packages/shared/wled-ble-protocol/test-vectors.json) define the wire format.

## Owner setup

Open the wall owner's Spraywall LED settings. Wi-Fi control still uses the local
controller address. **Install Bluetooth support (beta)** inspects that local controller,
checks its update/security page, and backs up configuration and presets on the
phone. The owner can export the backup before confirming any installation. A locked
controller links to its own security page; Boardsesh never bypasses PIN or OTA locks.
No Boardsesh login headers go to controller URLs; backend services never contact
a controller address.

An installation requires a matching release from the HTTPS manifest, owner
confirmation of the GL-C-015WL-D model, and a verified firmware download. An
unqualified release is installable only when explicitly marked `channel: "beta"`
and `qualified: false`, after the owner separately accepts the beta disclosure.
Stable releases must remain qualified; legacy qualified entries without a channel
are treated as stable. The beta is not proof of hardware or OTA qualification.
The audio-enabled image is preferred. An audio-disabled image is separately
identified and requires the owner's explicit confirmation. Installation uses
WLED's normal local multipart `/update` upload. Upload, reboot, and verification
are separate states. A disconnect alone never establishes success. An interrupted
upload leaves a local journal; inspection and verification must occur before a
new attempt. WLED's normal update workflow remains available.

A wall with no Wi-Fi installs over the controller's own hotspot (`WLED-AP`,
`http://4.3.2.1`). The manifest and every image the owner may install are
downloaded and verified first, on any internet; then the phone joins the
hotspot through the local `modules/wifi-join` Expo module (Android 10+
`WifiNetworkSpecifier` with a process binding, iOS `NEHotspotConfiguration`),
runs the same inspection, backup, consent, upload and verification, rejoins
after the restart, and leaves the hotspot on every exit. Requests to `4.3.2.1`
are refused unless the phone is on the hotspot, because that address is public.
Owner steps, platform prompts and the iOS entitlement are in
[Installing without Wi-Fi](#installing-without-wi-fi-controller-hotspot) below.

Beta installation is an explicit owner opt-in. The screen says that real-device
OTA, Android and iOS testing is incomplete and installation may fail or require
restoring WLED settings from the exported backup. The install action is labeled
**Install beta firmware**, and the engine rejects it before downloading unless
beta consent is provided. This consent is separate from model confirmation and
approval of an audio-disabled image.

The initial beta profile matches stock WLED 16.0.1 (`brand: WLED`, `product: FOSS`)
on classic ESP32 with 4 MB flash, for the owner-confirmed GL-C-015WL-D. Different
source versions, brands, products, architectures and flash sizes remain blocked.
Gledopto factory firmware is not implicitly treated as a matching source profile.
Empty manifests still allow backup but cannot install any image. CI artifacts
alone are not a release: the manifest must name the published image and its
verified HTTPS URL, byte size and SHA-256.

### Installing without Wi-Fi (controller hotspot)

Many walls have no Wi-Fi. A stock WLED controller with no Wi-Fi saved opens its
own access point, `WLED-AP` (default password `wled1234`), and serves itself at
`http://4.3.2.1`. That hotspot has no internet. The installer offers **Install
without Wi-Fi (controller's hotspot)** next to the Wi-Fi route, and selects it
when the wall has no saved address. The owner can change the network name and
password; both are prefilled with WLED's defaults.

1. **Download first.** On any internet, mobile data included, the app fetches
   the manifest and downloads every image the owner may install, checking each
   one's byte count and SHA-256 before it needs the controller. Beta images are
   only downloaded after the owner ticks the beta consent, which in this route
   comes before the download. A failed checksum stops here, before any join.
2. **Connecting to your controller.** The app asks the OS to join the hotspot
   (`modules/wifi-join`):
   - **Android 10+** shows the system "connect to device" sheet listing
     `WLED-AP`. The app requests it with a `WifiNetworkSpecifier` and binds its
     own process to that network with `bindProcessToNetwork`, so only Boardsesh
     uses the hotspot while mobile data stays the default for other apps. While
     bound, Boardsesh's own backend calls fail; the installer makes none.
     Android 9 and older are not supported: the screen tells the owner to join
     `WLED-AP` by hand, open `4.3.2.1` and put WLED on a Wi-Fi network instead.
   - **iOS** shows "Boardsesh wants to join Wi-Fi network WLED-AP" from
     `NEHotspotConfiguration` (`joinOnce`). iOS cannot bind requests to one
     network, so the join only counts once a Wi-Fi interface has an address on
     `4.3.2.0/24`. Then `4.3.2.1` is on the local subnet and never reached over
     mobile data.
   `4.3.2.1` is a public internet address, so every installer request to it is
   refused unless the phone is on the hotspot at that moment.
3. **Inspect, back up, upload, restart, check** run unchanged against
   `http://4.3.2.1`: backup and export, model, beta and audio consent, the
   OTA/PIN lock check, the journal, and read-back verification. The hotspot is
   kept from the ready backup to the owner's install tap, and nothing else.
   - **Same-network check.** WLED 16 refuses an update from a phone on its own
     hotspot while "Only allow update from same network/WiFi" is on (the default
     in 16; a factory 0.15 settings file has no such key): it compares the phone
     with its station address, `0.0.0.0` when it only runs the hotspot, and answers
     401 "Client is not on local subnet". When the backup shows it on, the
     installer records it in the journal, posts `{"ota":{"same-subnet":false}}` to
     `/json/cfg` before the upload, and posts `true` again after verification, or
     after a refused upload. The screen says so before the install tap. WLED 0.15
     has no such check, so nothing is written there.
   - **Controller name.** The owner names the controller (prefilled with the
     wall's name). The installer writes it as WLED's device name (`id.name`) before
     the upload, trimmed as the add-on trims it: whole characters within 22 UTF-8
     bytes, without `#` and `@`. The add-on advertises `<name>#<serial>`.
   - **Settings check.** Every setting in the backup must keep its value. Allowed:
     keys WLED adds when it rewrites the file, `rev`, Wi-Fi sleep (the add-on keeps
     modem sleep on while Bluetooth runs), unused button slots (`type` 0, every pin
     -1), a button count that only grows, the installer's two writes above, and the
     matched source profile's measured `settingsChanges` (see below). A failed check
     lists the differing paths on screen.
   - **Refused at the first byte.** A 401 from `/update` (PIN, OTA lock or the
     same-network check) means nothing was written: the journal is cleared and the
     screen shows the blocked state, not an unconfirmed install.
   - **Settings reloads** keep the LED section mounted, so a reload while the phone
     is on the hotspot no longer releases it mid-install.
4. **Restarting.** WLED's hotspot goes down while it restarts. Verification
   waits up to 15 s for the phone to rejoin on its own (Android's request stays
   registered and rebinds; iOS may rejoin a `joinOnce` network), then asks
   again, twice, up to 30 s each. iOS may show its join alert again here. If
   the hotspot never returns, the install is marked unconfirmed (`hotspotLost`)
   with the journal kept, and **Check installation** rejoins and verifies. That
   check stops as soon as the original firmware answers, puts the same-network
   setting back, and takes a fresh backup for the next attempt.
5. **Back to normal.** The app leaves the hotspot (Android unbinds and drops the
   request; iOS removes the configuration) and points the owner to Bluetooth →
   Find Bluetooth controller.

The hotspot is released on success, failure, cancel, sign-out, leaving the
screen and backgrounding. Android reports its own join sheet as backgrounding,
so a background event during a join is ignored; a join that lands while the
app is really in the background is undone. A JS reload or app teardown releases
it natively too. A WLED PIN or OTA lock cannot be opened from the app in this
route, because a browser does not use the app's hotspot binding: the owner
joins `WLED-AP` in Wi-Fi settings and unlocks it at `4.3.2.1/settings/sec`.

Error states: hotspot not found (Android also reports a refused sheet and a
wrong password this way), refused (iOS), timeout, invalid password (WPA2 needs
8 to 63 characters), unsupported phone, and hotspot lost after the restart.
Each has a retry. All hotspot installs share the `4.3.2.1` journal; one for a
different controller is refused by its hardware ID, as on Wi-Fi.

Native requirements: the iOS entitlement
`com.apple.developer.networking.HotspotConfiguration` (in `app.config.ts`),
which also needs the **Hotspot Configuration** capability enabled on the
`com.boardsesh.app` App ID in the Apple Developer portal; and Android's
`CHANGE_NETWORK_STATE` (a normal permission, no prompt). Joining is a native
change, so it ships with a new store build, not over the air. Real-device
Android and iOS joins, restarts and releases are untested until the
GL-C-015WL-D arrives.

## Climber control

Select Bluetooth in the wall's LED settings and discover by the dedicated service.
Capabilities must match the saved stable `wled-<12 lowercase MAC hex digits>` ID.
The wall setup stores `wled-ble:wled-<MAC>` in the existing text address column;
there is no database migration. Phone-specific peripheral IDs remain in memory,
and account/cache changes or backgrounding clear them and cancel pending work.
The previous local Wi-Fi address is retained in the phone's wall preferences when
switching transports. Clients that do not support a controller type disable it.

Probe only reads identity and state. Complete lighting operations are serialized
for each controller. Each operation connects, checks identity, sends acknowledged
JSON operations, then releases its connection with a bounded 1800 ms disconnect wait. A preview
re-arms brightness/nightlight and clears the previous climb on every connection,
because another phone or Wi-Fi client may have changed state between operations.
No interrupted lighting write is automatically replayed. Scan ownership is shared
with board and timer discovery so cancellation cannot stop another consumer's scan.

Firmware only exposes allowlisted runtime lighting changes. It cannot expose
credentials, alter configuration, reboot, update firmware, or persist presets.
A nearby unpaired phone can control live lighting while BLE is enabled. Disable
**BLE JSON / enabled** in WLED Usermod Settings to turn the service off. Generic
usermod builds default off; the Boardsesh image defaults on only when this saved
setting is absent. Output current limits remain WLED's responsibility.

## Radio framing and verification

Four-byte little-endian length prefixes frame each UTF-8 JSON request and response,
capped at 8192 bytes. Writes use responses; replies use indications. The native
client fragments by ATT MTU and supports 20-byte payloads. Identity is verified
on every connection before lighting. The firmware idle timeout also releases
unreachable links. Wi-Fi and Bluetooth update the same WLED state; the last
completed lighting command wins.

Post-install verification checks the same hardware identity, expected firmware,
BLE capability metadata, configuration, and presets. The backend receives no
controller backup. Physical LED observation remains separate from WLED's
application acknowledgement.

## Evidence required before a beta is marked qualified

First hardware target: Gledopto GL-C-015WL-D, classic ESP32, 4 MB. Baseline:
WLED 16.0.1 at `29b389df1c1aaec6ff53aea742d17063b985906c`. Standard application
slots are `0x180000` bytes each. Never repartition or replace filesystem contents
to make a candidate fit. Preserve LED chipset/count/color order/GPIOs, relay,
microphones, network settings, presets, and any existing BLE enabled setting.

Each source profile may carry `settingsChanges`, the settings its measured update
drops or changes, as `{ "path": "if.mqtt", "kind": "removed", "feature": "mqtt" }`
(dot paths, no array indexes). `removed`: the key must be gone afterwards (still
present with another value fails). `changed`: any value afterwards. The app never
accepts a waiver equal to, inside or above a protected setting: `hw.led.ins`,
`hw.led.total`, `hw.led.maxpwr`, `hw.relay`, `hw.btn.ins`, `hw.btn.pull`, `nw.ins`,
`ap`, `wifi`, `id.name`, `id.mdns`, `um.AudioReactive`, `um.BLE JSON`, `def`,
`light.gc`; `readManifest` rejects such a release. `feature` names an integration
the build leaves out (`mqtt`, `hue`, `alexa`, `ir`, `espnow`; any other name counts as
in use). When the backup shows one in use, the owner must confirm losing it before
installing, and the completion screen repeats it. Measured on 2026-11-26 for Gledopto
factory 0.15.4 (`brand`/`product` `GLEDOPTO`) to 16.0.1 with the add-on: `vid`
changed; removed `id.inv`, `nw.linked_remote`, `hw.led.ledma`, `hw.led.ld`,
`hw.led.prl`, `light.tr.mode`, `light.tr.fx`, `light.tr.pal`, `if.mqtt`, `if.hue`,
`if.va`, `hw.ir.pin`, `hw.ir.type`, `nw.espnow`, `if.sync.espnow`.

Record exact source firmware brand/product/version and partition evidence for
both factory Gledopto firmware and stock WLED 16.0.1. Each manifest source profile
must refer to that measured hardware/source combination before it is marked
qualified. Beta profiles explicitly retain `qualified: false` while evidence is
incomplete. Record the image SHA-256,
size, WLED/usermod/protocol versions, build ID, audio capability, and HTTPS asset.
Qualify subsequent updates and returning to compatible stock firmware as well.
A compiled image that fits does not prove installation on factory firmware works.

Real Android and iOS phones must exercise 500- and 1000-pixel bounds, replacement,
clear, brightness/nightlight rearming, audio effects to climbing and back,
two-phone handoff, backgrounding, sign-out during connect, and coexistence with a
board connection. Installer cases include PIN/OTA locks, incompatible hardware,
checksum/size failures, network loss, interrupted upload, preserved configuration,
and post-reboot BLE identity/build verification. Qualify audio and any separately
offered fallback independently. Physical LED output requires observation; WLED's
application acknowledgement does not provide that observation.

Host protocol, driver and mocked native/installer tests are automated. Real-phone,
factory OTA and physical LED evidence remains unrun until hardware is available.
The independent Astra source review complements this evidence; it does not replace
it. The owner-approved beta is available before these physical tests are complete,
with the disclosure and separate consent above. Stable qualification still
requires the recorded results.
