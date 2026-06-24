# Contributing to Boardsesh

[Join us on Discord](https://discord.gg/YXA8GsXfQK)

# Where work is tracked

The live roadmap lives on a single public GitHub project: [Boardsesh Roadmap](https://github.com/orgs/boardsesh/projects/3). Every issue sits in **Now**, **Next**, **Later**, or **Done**, and big multi-issue features carry an `Initiative` tag you can filter on. New issues you open land in **Later** by default — we'll triage from there.

Big features also get a **tracking issue** that lists their sub-issues in the order they should land. See [#1773 (Recently Climbed & Display Mode)](https://github.com/boardsesh/boardsesh/issues/1773) for the canonical pattern; copy the shape if you're proposing a similarly-sized change.

See [ROADMAP.md](./ROADMAP.md) for the full picture.

# Getting Started

## How to get everything going

Fork the repo on GitHub, clone your fork locally, create a branch, make your change, and open a pull request against `main`. Run the setup script below to get a working local environment before you start.

## One-Command Setup

Run the automated setup script:

```bash
# macOS/Linux
./scripts/setup-dev.sh

# Windows (PowerShell) — install Vite+ first, then run the script manually
irm https://vite.plus/ps1 | iex
```

This script will:

- Check all prerequisites (Node.js, Docker, etc.)
- Install dependencies
- Set up environment files
- Optionally collect Aurora API tokens for sync features
- Set up and populate the database
- Run database migrations
- Perform final checks

Once you've run setup, you will have a copy of both the Tension and Kilter climbs database on your computer!!

After setup completes, open [http://localhost:3000](http://localhost:3000) after starting the dev server and log in with `test@boardsesh.com` / `test`.

## Start Developing

After setup completes, start the development server:

```bash
vp run dev
```

This automatically starts the database containers (PostgreSQL, Redis), runs any pending migrations, and then launches the backend and web servers. Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can also run pieces independently:

- `vp run db:up` - Database only (PostgreSQL, Redis + migrations)
- `vp run dev:backend` - Database + backend only
- `vp run dev:web` - Database + web only

### Sharing a local dev database over Tailscale

If you have a bigger machine already running the dev database, smaller laptops can reuse it over your tailnet instead of starting Docker locally.

1. On the host machine, sign into Tailscale and run `vp run db:up`. The compose stack publishes Postgres and Redis on the host, and the bootstrap makes the dev Postgres accept password auth from the tailnet.
2. On the client machine, sign into the same tailnet and run `vp run dev` or `vp run db:up`. If no local Boardsesh Postgres is already running, the bootstrap scans online Tailscale peers for a Boardsesh dev DB and writes the selected connection to `.boardsesh/dev-db.env`.
3. Backend and web dev startup read `.boardsesh/dev-db.env` automatically, so the checked-in `localhost` defaults do not mask the selected tailnet host.

Local Docker still wins when it is already running. To force a specific peer, set `BOARDSESH_DEV_DB_HOST=<tailscale-host-or-ip>` before running `vp run db:up`.

This is only for development data. The dev database uses the shared local password, so keep port 5432 behind your machine firewall/Tailscale access controls.

### QA notes in the dev drawer

`vp run dev` exposes the current git branch in the user drawer during development. To add notes for the person testing the branch, create `.boardsesh/qa-notes.md` before starting the dev server, or pass an explicit file:

```bash
vp run dev -- --qa-notes-file docs/my-qa-notes.md
```

The notes are only served by the dev server and `.boardsesh/` is ignored by git.

## Testing web changes on Android

The web app no longer ships inside a native Android shell — the legacy Capacitor
wrapper has been retired in favour of the standalone React Native app
(`packages/mobile/`), which doesn't load the web UI. To check web changes on a
phone, open your dev server in a mobile browser.

`vp run dev` runs through `scripts/dev-with-tailscale.ts`, which binds the server
to your machine's [Tailscale](https://tailscale.com) MagicDNS name so a phone on
the same tailnet can reach it (without Tailscale it falls back to `localhost`,
which a real device can't reach). Look for
`[dev] Web URL: http://<your-host>.ts.net:3000` in the output and open that URL in
Chrome on your phone. Vercel preview URLs (`https://<preview>.boardsesh.com`) work too.

For the React Native app's own on-device workflow, see the mobile sections in
`CLAUDE.md` (`vp run dev:mobile`, `vp run mobile:android-shots`).

## Testing BLE end-to-end with an ESP32

The Bluetooth code path is the hardest one to validate without dragging a real climbing board into the room. To make end-to-end testing accessible to anyone, the repo ships a firmware that turns a generic ESP32 into a fake Kilter / Tension / Decoy / Touchstone / Grasshopper / MoonBoard. The phone or browser pairs with it like a real board, and every BLE write is forwarded over a WebSocket to a debug page in the web app, which decodes the payload and renders the lit-up holds — exercising the same encoder, framing, and protocol logic that runs against real hardware.

Cost is roughly £5 / $5 for the ESP32. Nothing else is needed — no LEDs, no level shifter, no soldering. A generic ESP32 dev board (DevKitC, WROOM-32, WROVER-E, S3 dev kit) works fine.

### One-time setup

1. **Install [PlatformIO Core](https://platformio.org/install/cli)** (`pip install platformio` or VS Code extension). The dev environment is `esp32-emulator`, defined in `packages/board-controller/esp32/platformio.ini`.
2. **Set Wi-Fi credentials.** The first build copies `packages/board-controller/esp32/.env.example` to `.env` automatically. `.env` is git-ignored, so edit it locally:
   ```
   EMULATOR_WIFI_SSID=your-network
   EMULATOR_WIFI_PASS=your-password
   ```
   2.4 GHz networks only — the ESP32 doesn't speak 5 GHz. WPA2 is fine; WPA3 is not (yet).
3. **Build and flash:**
   ```bash
   cd packages/board-controller/esp32
   pio run -e esp32-emulator -t upload
   ```
   If `esptool` errors with "Unable to verify flash chip connection" (some boards lack the auto-reset circuit), hold the **BOOT** button while the upload starts.
4. **Confirm the firmware came up.** Tail the serial log:
   ```bash
   pio device monitor --baud 115200
   ```
   You should see something like:
   ```
   [WiFi] Connected. IP: 192.168.20.38
   [BLE] Advertising as: Kilter Board#751737@3
   [WS] Listening on port 81
   ```
   Note the IP — the web UI needs it.

### Use it from the web app

> **The debug page only works from `http://localhost:3000`.** It opens a plain `ws://<esp32-ip>:81` socket, and browsers block plain WebSockets from HTTPS origins as mixed content. Vercel preview URLs and any other `https://` origin will load the page but the sockets will silently fail. Use a local dev server.

1. Run `vp run dev` and open `http://localhost:3000`.
2. Click your avatar (top-left) → **Development**. The menu entry only appears in development builds.
3. Click the **+** tab and fill in:
   - **IP address**: the one the firmware printed.
   - **Board / Layout / Size / Hold sets / Angle**: same cascading dropdowns as the "Custom Board" flow. Pick whichever board you're testing.
   - **Serial / API level**: any value; they only affect the BLE advertised name (e.g. `Tension Board#480221@3`).
4. Save. The tab opens a WebSocket to the ESP32 and pushes your config so it re-advertises with the right protocol and name.
5. From the phone or browser, open Boardsesh's BLE picker, pair with the advertised device, queue a climb, and send to board. The development tab decodes the BLE payload and renders the holds in real time.

You can keep multiple ESP32s connected in parallel — each one gets its own tab, sockets stay open in the background, and switching the active tab doesn't drop the others.

### What can it test?

- Aurora API v2 and v3 framing (`Q`/`R`/`S`/`T` and `M`/`N`/`O`/`P` command bytes), single- and multi-packet sequences, position+colour encoding, and v2 power-budget scaling.
- MoonBoard ASCII protocol (`l#S0,P35,E197#`) including chunked writes that span multiple BLE packets.
- Reconnect/disconnect handling, stale advertising name caching, and multi-board sessions.

It does **not** simulate LED hardware response timing, board-side errors, or the GATT side-channels Aurora uses for things like firmware updates — for those you still need a real board.

### Troubleshooting

- **Device doesn't show up in the BLE picker** after switching board type. iOS and macOS cache scan results; toggle Bluetooth off/on on the phone. The firmware already force-disconnects the central on config change, but the OS-level scanner cache is independent.
- **No serial output** after flashing. Press the ESP32's **EN/RST** button to reset; some adapters don't auto-reset reliably.
- **Wi-Fi never connects.** Re-check the SSID/password in `.env`. Boot logs print `[WiFi] Reason: 202 - AUTH_FAIL` on a bad password and `[WiFi] EMULATOR_WIFI_SSID empty` if the build script didn't pick up your `.env`.
- **Flashing fails at 921600 baud.** Some WROVER-E modules can't sustain it. The emulator env already drops to 460800; if yours still fails, lower further with `upload_speed = 230400` in `platformio.ini`.

## Keeping local data up to date

### Shared Data Sync (Public Climbs)

Once your server is running, you can manually trigger shared sync by visiting:

- **Kilter**: [http://localhost:3000/api/internal/shared-sync/kilter](http://localhost:3000/api/internal/shared-sync/kilter)
- **Tension**: [http://localhost:3000/api/internal/shared-sync/tension](http://localhost:3000/api/internal/shared-sync/tension)

This will sync the latest climbs, climb stats, beta links, and other data from Aurora's servers.

### Aurora User Data Sync (One-Way Only)

**Important**: Aurora user data sync is **one-way only** (Aurora → Boardsesh).

When you link your Aurora account in the app settings:

- Your Aurora data (logbook, ascents, climbs) is automatically imported to Boardsesh
- Data syncs immediately when you first link your account
- Automatic background sync runs every 6 hours to keep your data up-to-date
- **Data created in Boardsesh stays local and does NOT sync back to Aurora**

This is due to Aurora API limitations. Any ascents, climbs, or other data you create in Boardsesh will only exist locally in your Boardsesh account.

# Current status

Basic board use works, and the app already has queue controls. Open to feedback and contributions!
Using the share button in the top right corner, users can connect to each other and control the board and queue together.
Similar to Spotify Jams, no more "What climb was that?" "What climb was the last one?" "Mind if I change it?" questions during a sesh

## iOS support

Unfortunately, mobile Safari doesn't support web bluetooth. So to use this website on your phone, you could install an iOS browser that does have WebBLE support, for example, https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055

Bluefy is what I tested boardsesh in on my iphone and it worked like expected.

## Future features:

- Faster beta video uploads. Current process for beta videos is manual, and as a result new beta videos are almost never added. We'll implement our own Instagram integration to get beta videos faster.

# Self hosting

We plan to eventually have official support for self hosting, but currently it's still relatively involved to setup. Basically the development setup instructions should be used
for self-hosting too, but contributions would be very welcome.
The app is just a standard next.js app with Postgres.

# Thanks

This app was originally started as a fork of https://github.com/lemeryfertitta/Climbdex.
We also use https://github.com/lemeryfertitta/BoardLib for creating the database.
Many thanks to @lemeryfertitta for making this project possible!!
