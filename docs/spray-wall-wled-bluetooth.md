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
4. **Restarting.** WLED's hotspot goes down while it restarts. Verification
   waits up to 15 s for the phone to rejoin on its own (Android's request stays
   registered and rebinds; iOS may rejoin a `joinOnce` network), then asks
   again, twice, up to 30 s each. iOS may show its join alert again here. If
   the hotspot never returns, the install is marked unconfirmed (`hotspotLost`)
   with the journal kept, and **Check installation** rejoins and verifies.
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
