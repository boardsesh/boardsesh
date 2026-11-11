# Boardsesh BLE usermod for WLED

> **Unbuilt and untested.** Nobody has compiled this code or run it on a
> controller yet. It is reference source for
> [`docs/spray-wall-led-ble.md`](../../docs/spray-wall-led-ble.md). Expect to fix
> compile errors against the exact WLED and NimBLE-Arduino versions you use, and
> keep a USB cable at hand for the serial fallback below.

The usermod adds a Bluetooth LE GATT service to WLED, so the Boardsesh app can
light a Spraywall without the phone joining the Spraywall's Wi-Fi. WLED's web UI,
Wi-Fi JSON API, presets and OTA updates keep working.

| File | What |
| --- | --- |
| `usermod_boardsesh_ble.h` | The usermod: NimBLE service, frame queue, frame → WLED JSON |
| `boardsesh_ble.cpp` | Self-registration for WLED with `custom_usermods` (after 0.15) |
| `library.json` | PlatformIO library manifest (`libArchive: false`, NimBLE-Arduino 1.4.x) |
| `platformio_override.ini` | Build environments for the Gledopto GL-C-015WL-D |

WLED core changes: **none** on WLED with `custom_usermods`. On WLED 0.15.x, the
usual usermod registration in `wled00/usermods_list.cpp` (three lines, below) is
needed, because 0.15.x has no other way to register a usermod. It changes no
behaviour.

## The controller

Gledopto GL-C-015WL-D: ESP32 (dual-core, 240 MHz), WLED pre-installed, LED data on
GPIO16, a second output, an extra IO33 pin, a built-in microphone and a Micro-B
UART port for serial flashing. **Not published**: the module, flash size, PSRAM,
the WLED version it ships and the partition table. Sources:
[product page](https://shg-website.pages.dev/products/gl-c-015wl-d),
[Dialed In listing](https://shop.dialedin.com.au/products/wled-esp32-addressable-15a-controller),
[Superlighting WLED manual](https://superlightingled.com/PDF/WLED-Series-LED-Controller-Manual.pdf).

## Before you build

1. In the controller's WLED UI, open **Info** and write down the version, the
   free heap and the "Environment" (build) name.
2. Save a full backup with USB (`esptool.py --chip esp32 read_flash 0 ALL backup.bin`,
   or `0 0x400000` for 4 MB) and **Config → Backup** in the UI.
3. Read the flash size and partition table:
   `esptool.py flash_id` and
   `esptool.py read_flash 0x8000 0xc00 partitions.bin` (then
   `gen_esp32part.py partitions.bin`). OTA only works if the new image fits the
   factory app slot.

## Build (PlatformIO, by a human)

1. Get WLED's source at the tag that matches step 1 (or newer) and install
   PlatformIO.
2. Copy this folder to `usermods/boardsesh_ble/` in the WLED checkout.
3. Copy `platformio_override.ini` to the WLED root.
4. **WLED with `custom_usermods`** (after 0.15):
   `pio run -e gledopto_boardsesh_ble`

   **WLED 0.15.x**: add to `wled00/usermods_list.cpp`, with the other includes
   and in `registerUsermods()`:

   ```cpp
   #ifdef USERMOD_BOARDSESH_BLE
     #include "../usermods/boardsesh_ble/usermod_boardsesh_ble.h"
   #endif
   // inside registerUsermods():
   #ifdef USERMOD_BOARDSESH_BLE
     usermods.add(new BoardseshBleUsermod());  // UsermodManager::add(...) on trees that have it
   #endif
   ```

   then `pio run -e gledopto_boardsesh_ble_015`.
5. Check the size line at the end of the build: the app must fit the app slot
   from "Before you build" with some room to spare. If it does not, drop
   `audioreactive` or more features (`-D WLED_DISABLE_…`).

The image is `build_output/release/*.bin` (or `.pio/build/<env>/firmware.bin`).

## Flash over the air (WLED's update page)

1. Open `http://<controller>/update` (Settings → Security & Updates → Manual
   OTA update) on the same Wi-Fi.
2. If OTA is locked, unlock it on the Security page with the OTA password.
3. Choose the `.bin` and **Update!**. The controller reboots in about a minute.
4. Open Settings → Usermods: a **Boardsesh BLE** block shows the passkey.

## Serial fallback

If OTA refuses the image (too big for the slot, wrong chip) or the controller
does not come back:

1. Connect the Micro-B UART port to a computer. Hold the button while plugging
   in if the board does not enter download mode by itself.
2. `esptool.py --chip esp32 --baud 460800 write_flash 0x10000 firmware.bin`
   (app only), or `pio run -e <env> -t upload`.
3. To restore: `esptool.py write_flash 0 backup.bin`.
4. A full erase (`erase_flash`) also deletes WLED's settings; restore them from
   the Config backup.

## Settings → Usermods → Boardsesh BLE

| Setting | Meaning |
| --- | --- |
| enabled | Start Bluetooth at boot (restart after changing it) |
| passkey | The 6 digits a phone types the first time it pairs. Random on first boot |
| pairingOpen | New phones may pair. On for 10 minutes after every boot and after ticking it |
| forgetAllPhones | Tick and save to delete every bonded phone |

**Untick Settings → WiFi → "Disable WiFi sleep".** ESP-IDF needs Wi-Fi modem
sleep while Bluetooth runs. The usermod turns sleep back on when Wi-Fi connects
and the Info page warns while the option is ticked, but leaving it ticked is
untested.

## Device test plan

1. Build and flash as above. Info shows `Boardsesh BLE: advertising`; note the
   free heap and compare it with the value from before.
2. Wi-Fi still works: the Boardsesh app's Wi-Fi controller type can light all
   and turn off, and WLED's UI responds.
3. With a BLE scanner app (nRF Connect), the controller advertises service
   `7e100001-69ea-4190-8731-75eec7496aed`. Read Info: the first byte is `01`,
   then the LED count.
4. In Boardsesh: edit the Spraywall → LEDs → Bluetooth → **Find Bluetooth
   controller** → pick it. Light all: the phone asks for the passkey; type the
   one from WLED's Usermods page. The Spraywall lights white.
5. Turn off. Then set a brightness and auto-off of 15 minutes; light all again
   and check WLED's nightlight turns the Spraywall off after 15 minutes.
6. Open a climb on the Spraywall: its holds light in their colours; switch
   climbs and only the new holds stay lit.
7. A second phone: it cannot connect while the first is connected; it can 60 s
   after the first stops sending. Outside the pairing window it cannot pair.
8. Range: light a climb from the far end of the mat and from the next room.
9. With a Kilter/Tension/MoonBoard connected on the same phone, light the
   Spraywall: both keep working.
10. Leave it on for an hour with a phone connected and Wi-Fi in use: no reboots
    (Info → uptime) and the heap does not shrink.
