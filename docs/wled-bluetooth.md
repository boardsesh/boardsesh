# WLED Bluetooth for Spraywalls

Boardsesh supports a separate WLED JSON-over-BLE controller type, `wled-ble`.
Firmware lives in the public [wled-usermod-ble-json repository](https://github.com/boardsesh/wled-usermod-ble-json).
It is an external WLED usermod, independent of Aurora and MoonBoard protocols.
The shared [protocol contract](../packages/shared/wled-ble-protocol/protocol.md)
and [test vectors](../packages/shared/wled-ble-protocol/test-vectors.json) define the wire format.

## Owner setup

Open the wall owner's Spraywall LED settings. Wi-Fi control still uses the local
controller address. **Install Bluetooth support** inspects that local controller,
checks its update/security page, and backs up configuration and presets on the
phone. The owner can export the backup before confirming any installation.
No Boardsesh login headers go to controller URLs; backend services never contact
a controller address.

An installation requires a matching qualified release from the HTTPS manifest,
owner confirmation of the GL-C-015WL-D model, and a verified firmware download.
The audio-enabled image is preferred. An audio-disabled image is separately
identified and requires the owner's explicit confirmation. Installation uses
WLED's normal local multipart `/update` upload. Upload, reboot, and verification
are separate states. A disconnect alone never establishes success. An interrupted
upload leaves a local journal; inspection and verification must occur before a
new attempt. WLED's normal update workflow remains available.

**No hardware combinations are qualified in the initial manifest.** Firmware
artifacts produced by build CI are development candidates only. The installer
cannot upload one until the required release evidence is recorded and a qualified
manifest entry is published. This gate is intentional; do not add an entry based
only on a successful compiler or mocked test result.

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
JSON operations, then releases its connection within two seconds. A preview
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

## Qualification record required before installation is enabled

First hardware target: Gledopto GL-C-015WL-D, classic ESP32, 4 MB. Baseline:
WLED 16.0.1 at `29b389df1c1aaec6ff53aea742d17063b985906c`. Standard application
slots are `0x180000` bytes each. Never repartition or replace filesystem contents
to make a candidate fit. Preserve LED chipset/count/color order/GPIOs, relay,
microphones, network settings, presets, and any existing BLE enabled setting.

Record exact source firmware brand/product/version and partition evidence for
both factory Gledopto firmware and stock WLED 16.0.1. Each manifest source profile
must refer to that measured hardware/source combination. Record the image SHA-256,
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
The independent Astra source review complements these gates; it does not replace
them.
