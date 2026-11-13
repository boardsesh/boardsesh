# WLED Bluetooth Spraywall controllers

Boardsesh supports the independent BLE JSON WLED usermod from
[boardsesh/wled-usermod-ble-json](https://github.com/boardsesh/wled-usermod-ble-json).
The initial target is Gledopto GL-C-015WL-D with classic ESP32 and 4 MB flash.
Firmware installation is available as an explicitly disclosed owner-approved beta.
A beta manifest entry uses `channel: "beta"` and `qualified: false`; it does not
claim real-device qualification. Stable entries require `qualified: true`. Source
builds and host tests alone do not qualify hardware.

## Owner setup

Open Edit board → LEDs. Wi-Fi remains the default. The Install Bluetooth support (beta)
flow inspects the controller on its local network, saves configuration and
presets on the owner's phone, and offers export before an installation can be
confirmed. An empty manifest permits inspection and backup, and keeps installation unavailable.
A matching beta release requires a separate beta consent before downloading or
uploading. The warning says real-device OTA, Android and iOS testing is incomplete
and WLED settings may need restoring from the backup. Model confirmation and
audio-disabled approval remain separate. The initial beta matches stock WLED
16.0.1 with brand WLED and product FOSS on classic ESP32, 4 MB; it does not
automatically match different Gledopto factory versions or architectures. A locked controller links to its own WLED
security page; Boardsesh does not bypass PIN or OTA locks.

Installation downloads the HTTPS firmware asset and verifies its byte count and
SHA-256 before local multipart upload. Upload, reboot and verification are
separate states. An interrupted upload is recorded locally. Checking the
controller is required before a retry; an HTTP disconnect never counts as
successful installation. Verification matches the same hardware identity,
expected firmware and BLE capability metadata, configuration and presets.
The backend never connects to a controller IP and receives no firmware backup.

For firmware with Bluetooth already enabled, select Bluetooth → Find Bluetooth
controller. Discovery reads capabilities without lighting the wall. Choose the
controller by its name and stable ID, then test lighting. Switching to Wi-Fi
restores this phone's previous address.

## Radio behavior

The saved wall setup contains `wled-ble:wled-<12 lowercase hexadecimal digits>`.
The suffix is the controller's hardware ID, not an Android address or iOS
peripheral UUID. Phone-specific IDs are kept only in memory and cleared on
account changes, LED cache erasure and backgrounding.

The service and characteristics use the independent protocol documented in the
usermod repository. WLED commands retain JSON semantics. Four-byte little-endian
length prefixes frame each UTF-8 JSON request and response, capped at 8192 bytes.
Writes use responses; replies use indications. The native client fragments by
ATT MTU and supports 20-byte payloads. A controller ID is verified after every
connection before any lighting command. Complete lighting operations serialize
per controller. Connections are released immediately afterward, with a bounded
1800 ms disconnect wait. Cancellation and timeouts discard work without replay.
The firmware's idle timeout also releases an unreachable link.

Acknowledge means WLED accepted a state update. It is not physical LED feedback.
Wi-Fi and BLE update the same WLED state; the last completed lighting command
wins. Current limiting stays with WLED's existing configuration. No pairing code
is requested, and any nearby climber can control runtime lighting.

The shared ble-plx scan slot prevents Spraywall scans from replacing other
scans. Cleanup only stops a scan if it still owns that slot; foreground board
pickers retain their priority. Existing board connections are never cancelled
by Spraywall discovery or lighting.

## Release evidence

Before changing a beta profile to a qualified stable release, record all of the
following in the firmware release's qualification evidence:

1. OTA from the actual Gledopto factory image and pinned stock WLED 16.0.1,
   using the existing partition layout, with config and preset preservation.
2. Android and iOS lighting on 500 and 1000 pixels, bounds checks, replacing and
   clearing climbs, audio/climbing transitions, and two-phone handoff.
3. Backgrounding, sign-out during connect, interrupted uploads, locked OTA/PIN,
   subsequent OTA, and returning to compatible stock WLED.
4. Audio-enabled image fit in the 1.5 MiB app slot, or an explicitly confirmed,
   separately qualified audio-disabled fallback.
5. Independent Astra/Fable BLE review and required Boardsesh checks.

No physical controller, Android/iOS radio, firmware OTA, microphone or physical
LED preservation evidence is established by unit tests. An owner may install a matching beta before those checks are complete, after
explicitly accepting the disclosed beta status. Keep `qualified: false` until
those checks have recorded results; never relabel an untested beta as qualified.
