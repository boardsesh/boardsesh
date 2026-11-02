# Spray wall LED setup (MVP)

Edit an existing spray wall and expand **LED**, immediately above **More options**.
Enable LEDs to show the WLED address and setup controls. This first version supports
one surface with one WLED controller. It does not illuminate climbs or map holds yet.

## Using it

1. Enable LEDs and enter the controller's base address, such as `http://wled.local`.
2. Tap **OK** to check the connection. A successful check saves the address and
   shows the device name and LED count. It does not change the lighting.
3. If the controller is offline or does not return a WLED response, choose
   **Keep address anyway** to save it. Invalid URL syntax must be corrected.
4. After a successful check, **Light all LEDs** sets the entire configured strip
   to solid white at 25% brightness. **Turn LEDs off** ends the test.
5. **LED setup** currently explains that hole positions, LED positions and hold
   matching are not developed yet.

These settings save immediately on this device, separately for each wall. Turning
the setting off hides the remaining controls and retains the saved controller URL.
An unconfirmed address draft is not saved on leaving the screen. Disabling LED
support is a configuration change; it sends no hardware command. Use **Turn LEDs
off** to turn off a running test.

## Controller boundary

`@boardsesh/led-controller` owns URL validation and transport, with a driver registry
and `probe`, `lightAll` and `turnOff` operations. Add future systems as drivers,
then extend the versioned settings discriminator and provider selection UI. The
editor does not contain WLED request payloads. No database migration or backend
proxy is needed: requests originate on the phone/browser in the controller's LAN.
Controller URLs do not enter shared board metadata, analytics or server requests.

The WLED implementation uses the official
[JSON API](https://kno.wled.ge/interfaces/json-api/): read-only `GET /json/info`
for checks and `POST /json/state` for explicit lighting commands. Requests are
bounded by timeouts and cancelled on edits, collapse, disable and unmount.
Success requires a valid WLED response or command acknowledgement. A physical
light change still needs device QA.

The design follows the separation used in
[CRUX WLED Bridge](https://github.com/Spikeystrike/cruxwledbridge): a hold, a wall
hole and a physical LED are different things. No CRUX source was copied, and no
mapping is guessed in this MVP. Later setup can add those layers without changing
the controller transport.

The lighting test requires a **1D WLED strip configuration**. It covers the
configured LED count, resets segment 0 to the full cable, and puts existing
segments into solid white with no grouping, spacing, offset or freeze. This
replaces live effects, segment transforms and brightness; it does not restore the
previous light state. It does not save/delete presets or write `/json/cfg`.
Firmware-level LED maps and 2D matrices are outside this MVP.

Existing spray-wall BLE capabilities and `user_boards.has_leds` remain unchanged.
This is independent LAN setup, not a claim that spray walls speak Aurora BLE.

## Testing a fork on Android

Use a development client and a local/self-hosted backend, as required by
[the fork policy](../LEGAL.md#hosted-service--api-access). Do not distribute a fork
pointed at Boardsesh's hosted accounts, backend or update service.

The dev-only component story `spray-wall-led-section--setup` exercises this same
component with a separate local settings key, without needing an existing wall.
Open `dev/stories/spray-wall-led-section--setup` in a development build after
signing in against your own backend; the native app's authentication gate also
applies to stories. It can
contact a real WLED device only when you enter its address and press a control.
Use **Edit spray wall** against your own backend to check full form placement.

Android development clients allow HTTP traffic for Metro/local development.
Verify the actual installed build with the controller: a release build may
restrict cleartext HTTP. Supporting arbitrary local HTTP controllers in release
builds needs a deliberate native network policy and a new binary; this change
does not silently relax that policy. On iOS, local-network permission and ATS
configuration likewise need a native-build check. Browser mixed-content, CORS
and local-network restrictions can make a reachable controller inaccessible to
the app; a failed test never prevents retaining the address.

All visible strings are in the `boards.sprayLed` catalogs for English, German,
Spanish, French and Italian. Validate the driver, storage and component tests,
then the mobile typecheck, mobile suite and native bundle check. Verify on a phone
in light/dark mode and with large text, including offline retention and disabling
then re-enabling after reopening the editor.
